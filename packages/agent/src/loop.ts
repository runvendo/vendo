/**
 * The turn loop — ONE implementation, every caller.
 *
 * This is the `streamText` call that used to live inside `createAgent`'s
 * `createUIMessageStream` closure, lifted out verbatim so it can also be driven
 * by a `Harness` (`vendo()` in @vendoai/harnesses). Extracting it is what makes
 * the harness a genuine lift rather than a parallel reimplementation: every rail
 * here — the step cap, `buildFailedStop`, the history window, the cache
 * breakpoints, the abandoned-approval provider rewrite, the tool-search loadout —
 * is shared, so a rail can only be dropped by deleting it for BOTH callers, and
 * @vendoai/agent's own suite is the specification that would catch that.
 *
 * What is deliberately NOT here: how output reaches a consumer. `createAgent`
 * merges `result.toUIMessageStream()`; the harness reads `result.fullStream` and
 * yields events. Everything before that fork is identical.
 */
import {
  ASK_USER_TOOL,
  VendoError,
  VENDO_MAKE_TOOL,
  VENDO_APP_BUILD_FAILED_PREFIX,
  type RunContext,
  type TurnId,
  type VendoStepLimitPart,
} from "@vendoai/core";
import {
  convertToModelMessages,
  isToolUIPart,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UIMessage,
} from "ai";
import { failoverModel, type ResolvedModel } from "./failover.js";
import type { ToolSearchSession } from "./tool-search.js";

// AGENT-7: the default agent-loop step cap (unchanged from the previously
// hardcoded value); hosts raise or lower it via context.maxSteps.
export const DEFAULT_MAX_STEPS = 20;

/** §4.1 item 3 — the per-turn provider retry budget, STATED. It used to be unset,
 *  so the loop inherited whatever the SDK's default happened to be: a posture
 *  nobody chose, that no reader of this file could see, and that a minor version
 *  bump could change under us. The value matches the SDK's own default, so making
 *  it explicit changed no behaviour — only who owns it. */
export const DEFAULT_MAX_RETRIES = 2;

// Anthropic prompt-caching breakpoint. providerOptions.anthropic is ignored by every
// other provider (and by the test mocks), so marking breakpoints degrades to a no-op.
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** 0.4.4 cert defect B — a terminally failed app BUILD ends the turn. A build
 *  is a minutes-long operation and its failure is deterministic for the same
 *  ask, so letting the model auto-retry inside the turn kept the thread
 *  streaming for up to maxSteps × build-length with nothing visible. The tool
 *  bridge has already streamed the `data-vendo-build-failed` banner with the
 *  classified reason by the time this fires; re-asking is the user's call
 *  (the same resolution the BYO embed's failed vocabulary points at). */
const buildFailedStop: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  return last !== undefined && last.toolResults.some((result) => {
    if (result.toolName !== VENDO_MAKE_TOOL) return false;
    // Scoped to the runtime's build-failed class (the canned prefix): a cheap
    // create error (input validation, feature-flag refusal) costs seconds,
    // stays model-visible, and the loop may recover from it.
    const output = result.output as { status?: unknown; error?: { message?: unknown } } | null;
    return typeof output === "object" && output !== null
      && output.status === "error"
      && typeof output.error?.message === "string"
      && output.error.message.startsWith(VENDO_APP_BUILD_FAILED_PREFIX);
  });
};

/** Design §4 + §6 — a question through the one door is TURN-ENDING. The builder
 *  "asks the user … and dies"; build contract §8 cuts steering, so there is no
 *  mid-turn answer to wait for. Without this the model keeps its own steps after
 *  asking, which is precisely the invention `ask_user` exists to prevent: it
 *  guesses an answer and carries on, and the user's real reply lands a turn too
 *  late to matter. A REFUSED question (unattended, blank) is not a stop — the
 *  model still has to finish what it can. */
const askedUserStop: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  return last !== undefined && last.toolResults.some((result) => {
    if (result.toolName !== ASK_USER_TOOL) return false;
    const output = result.output as { status?: unknown } | null;
    return typeof output === "object" && output !== null && output.status === "ok";
  });
};

/**
 * §4.1 item 4 — a token ceiling for one turn, as one more StopCondition. The
 * caller closes over whose ceiling it is (a tenant, a seat, a plan), because the
 * loop has no business knowing.
 *
 * A StopCondition is consulted AFTER a step, so crossing the ceiling always costs
 * the step that crossed it. That is what makes this a budget rather than a hard
 * cap, and it is the only honest shape available: token spend is not knowable
 * until the provider reports it.
 */
export function tokenBudgetStop(maxTotalTokens: number): StopCondition<ToolSet> {
  return ({ steps }) => steps.reduce((spent, step) => {
    const { totalTokens, inputTokens, outputTokens } = step.usage;
    return spent + (totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0));
  }, 0) >= maxTotalTokens;
}

/** An approval the conversation abandoned reaches the PROVIDER as a denied tool
 *  call, not as our internal `approval-responded` state. */
export function providerHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part)
        || part.state !== "approval-responded"
        || part.approval.approved !== false
        || part.approval.reason !== "abandoned") {
        return part;
      }
      return {
        ...part,
        state: "output-denied",
        approval: { ...part.approval, approved: false },
      };
    }),
  }));
}

/**
 * Prompt tokens per character. An ESTIMATE, deliberately: there is no tokenizer
 * in this repo and adding one buys accuracy the budget does not need — a
 * per-provider vocabulary is megabytes, is wrong for every model it was not
 * built for, and would have to load before the first turn. Four characters per
 * token is within a few percent of every BPE tokenizer on English prose and
 * JSON, and both directions of error are cheap: under-shedding is caught by the
 * provider's own context limit, over-shedding costs one extra old message.
 */
const CHARS_PER_TOKEN = 4;

/** The estimate, over the wire form the provider is actually billed for. */
function estimateTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}

/**
 * Shed a turn's history to a token budget, CHEAPEST LOSS FIRST:
 *
 *   1. reasoning — never re-read by the model after the step that produced it;
 *   2. old tool payloads — a result the conversation has already summarised, and
 *      the newest exchange keeps its own;
 *   3. the oldest messages — the only band that loses something a later turn may
 *      refer to, so it is the last resort.
 *
 * `pruneMessages` (shipped in `ai`) does bands 1 and 2, and it drops a tool call
 * together with its result, so the prompt stays well-formed however much it
 * sheds. The ask always survives: a turn with no user message is not a cheaper
 * turn, it is a broken one.
 */
function shedToBudget(
  messages: readonly ModelMessage[],
  system: string,
  budget: number,
): ModelMessage[] {
  // The system prompt is part of the same window and is not sheddable, so it is
  // charged against the budget rather than ignored by it.
  const overhead = estimateTokens([{ role: "system", content: system }]);
  const fits = (candidate: readonly ModelMessage[]): boolean =>
    estimateTokens(candidate) + overhead <= budget;
  if (fits(messages)) return [...messages];
  let shed = pruneMessages({
    messages: [...messages],
    reasoning: "before-last-message",
    emptyMessages: "remove",
  });
  if (fits(shed)) return shed;
  shed = pruneMessages({ messages: shed, toolCalls: "before-last-message", emptyMessages: "remove" });
  if (fits(shed)) return shed;
  while (shed.length > 1 && !fits(shed)) shed = shed.slice(1);
  return shed;
}

/**
 * The provider messages for one turn: the system prompt, the optionally windowed
 * and budgeted history, and the cache breakpoints that keep a growing thread from
 * re-billing.
 */
export async function turnModelMessages(
  messages: UIMessage[],
  system: string,
  historyWindow: number | undefined,
  tokenBudget?: number,
): Promise<ModelMessage[]> {
  // History windowing: bound what is re-sent per turn to the last N whole messages.
  // Slicing whole UIMessages keeps each turn's tool-call/result pairing intact.
  const history = historyWindow !== undefined && messages.length > historyWindow
    ? messages.slice(-historyWindow)
    : messages;
  let converted = (await convertToModelMessages(providerHistory(history)))
    .filter((message) => message.content.length > 0);
  // Budgeting runs on the CONVERTED form because that is the form the provider
  // bills, and it runs before the breakpoints below because shedding changes
  // which message is the stable prefix's last one.
  if (tokenBudget !== undefined) converted = shedToBudget(converted, system, tokenBudget);
  // Cache the stable history prefix (everything but the final message) alongside the
  // static system prompt below, so Anthropic re-reads the cached prefix instead of
  // re-billing the whole growing thread each turn.
  if (converted.length >= 2) {
    const prefixEnd = converted[converted.length - 2] as ModelMessage;
    prefixEnd.providerOptions = { ...prefixEnd.providerOptions, ...CACHE_BREAKPOINT };
  }
  return [
    { role: "system", content: system, providerOptions: CACHE_BREAKPOINT },
    ...converted,
  ];
}

export interface TurnLoopOptions {
  model: LanguageModel;
  /** §4.1 item 3 — the rungs BELOW `model`, tried in order when a provider fails
   *  before producing any output. Unset (the normal case) means no ladder is built
   *  and the model reaches `streamText` exactly as it does today. See
   *  {@link failoverModel} for why the boundary is the first byte. */
  fallbacks?: readonly ResolvedModel[];
  system: string;
  messages: UIMessage[];
  /** Already built and guard-bound by the caller (buildAgentTools, or the
   *  harness runtime's delegating set). */
  tools: ToolSet;
  signal?: AbortSignal;
  /** §3.5 — the turn this loop is running, for anything downstream that has to
   *  name it. Optional only because a caller may drive the loop outside a
   *  composed turn; every composed caller mints one. */
  turnId?: TurnId;
  context?: TurnContext;
  /**
   * §4.1 item 6 — the supervisor slot, shipped as a NO-OP. Unset means
   * `{ok: true}` and costs the turn nothing: the final answer is not even
   * awaited for it.
   *
   * `ctx` travels beside the hook because the signature is a frozen inter-project
   * seam that asks for one, and the loop holds no `RunContext` of its own. That is
   * also why only `createAgent` can fill this: a `Turn` deliberately carries no
   * ctx, so a harness has none to hand over.
   */
  supervision?: { ctx: RunContext; supervise: Supervise };
  /** Extra stop conditions, COMPOSED with the loop's own three rather than
   *  replacing them. The array used to be a literal, so a caller who needed a
   *  fourth condition had nowhere to put it and would have had to grow a second
   *  stop mechanism beside this one. */
  stopWhen?: readonly StopCondition<ToolSet>[];
  toolSearch?: ToolSearchSession;
}

/** The per-turn knobs, one shape both callers pass so neither can carry half of
 *  them (`vendo()` used to pass `maxSteps` alone, which made every other knob
 *  structurally unreachable from the default harness). */
export interface TurnContext {
  maxOutputTokens?: number;
  /** Bound the messages re-sent per turn to the last N whole messages. */
  historyWindow?: number;
  /** §4.1 item 2 — bound the PROMPT instead of the message count: reasoning and
   *  old tool payloads are shed before any message is dropped. Estimated, not
   *  tokenized (see {@link CHARS_PER_TOKEN}). */
  contextTokenBudget?: number;
  maxSteps?: number;
  /** How many times the SDK re-issues a failed provider call. Defaults to
   *  {@link DEFAULT_MAX_RETRIES}; 0 spends nothing. */
  maxRetries?: number;
}

/**
 * §4.1 item 6 — FROZEN signature (inter-project seam; the verification project
 * is the consumer). A verdict on the turn's final answer: `{ok: true}` lets it
 * stand, `{ok: false}` withholds it with a reason the user is shown.
 */
export type Supervise = (input: {
  turnId: TurnId;
  answer: string;
  ctx: RunContext;
}) => Promise<{ ok: true } | { ok: false; reason: string }>;

export interface TurnLoop {
  result: ReturnType<typeof streamText>;
  maxSteps: number;
  /**
   * AGENT-7: exhausting the step cap is VISIBLE. Call after the stream drains —
   * a run that still wanted tool calls after its final permitted step ended
   * because of the cap, not because the model finished.
   */
  stepLimitPart(): Promise<VendoStepLimitPart | undefined>;
  /**
   * §4.1 item 6 — the supervisor's verdict on the final answer, as an ERROR the
   * caller sends through the failure path it already has. A `VendoError` because
   * that is the one shape `wireErrorMessage` passes through recognizably: the
   * reason is ours and crafted, so the user reads it instead of the generic line,
   * and no new wire part or `HarnessEvent` member had to exist for this.
   *
   * Resolves `undefined` when no supervisor is configured — including without
   * awaiting the answer, so an unset slot is not even a scheduling difference.
   */
  supervisorRefusal(): Promise<VendoError | undefined>;
}

/** The model `streamText` is handed: the one the caller named, or the ordered
 *  ladder when it named more. Unset fallbacks build nothing at all, so a
 *  single-model turn is byte-for-byte the call it was before failover existed. */
function turnModel(options: TurnLoopOptions): LanguageModel {
  const fallbacks = options.fallbacks ?? [];
  if (fallbacks.length === 0) return options.model;
  const primary = options.model;
  if (typeof primary === "string" || primary.specificationVersion !== "v3") {
    throw new VendoError("validation", "provider failover needs a resolved v3 model as the primary");
  }
  return failoverModel([primary, ...fallbacks]);
}

export async function startTurn(options: TurnLoopOptions): Promise<TurnLoop> {
  const maxSteps = options.context?.maxSteps ?? DEFAULT_MAX_STEPS;
  if (options.supervision !== undefined && options.turnId === undefined) {
    // A verdict nobody can attribute is not a verdict. Every composed caller
    // mints a turn id, so this is a wiring mistake, not a runtime condition.
    throw new VendoError("validation", "supervision needs the turn it is judging (turnId)");
  }
  const modelMessages = await turnModelMessages(
    options.messages,
    options.system,
    options.context?.historyWindow,
    options.context?.contextTokenBudget,
  );
  const { toolSearch } = options;
  const result = streamText({
    model: turnModel(options),
    messages: modelMessages,
    tools: options.tools,
    stopWhen: [stepCountIs(maxSteps), buildFailedStop, askedUserStop, ...(options.stopWhen ?? [])],
    maxOutputTokens: options.context?.maxOutputTokens,
    // Stated rather than inherited — see DEFAULT_MAX_RETRIES.
    maxRetries: options.context?.maxRetries ?? DEFAULT_MAX_RETRIES,
    // ENG-252 loadout: restrict what the model may pick to the current loadout.
    // `prepareStep` re-reads it each step so a tool loaded via
    // `vendo_tools_search` becomes callable on the very next step. This gates the
    // model's CHOICE only — every tool still executes through the guard-bound
    // registry, so there is no unguarded path.
    ...(toolSearch === undefined
      ? {}
      : {
          activeTools: toolSearch.activeToolNames(),
          prepareStep: () => ({ activeTools: toolSearch.activeToolNames() }),
        }),
    // AGENT-3: cancellation reaches the provider call itself; the loop never
    // starts another step once the signal fires.
    abortSignal: options.signal,
  });

  return {
    result,
    maxSteps,
    async supervisorRefusal() {
      const { supervision, turnId } = options;
      if (supervision === undefined || turnId === undefined) return undefined;
      const verdict = await supervision.supervise({
        turnId,
        answer: await result.text,
        ctx: supervision.ctx,
      });
      if (verdict.ok) return undefined;
      return new VendoError("blocked", verdict.reason);
    },
    async stepLimitPart() {
      try {
        const [finishReason, steps] = await Promise.all([result.finishReason, result.steps]);
        if (finishReason !== "tool-calls" || steps.length < maxSteps) return undefined;
        return {
          type: "data-vendo-step-limit",
          limit: maxSteps,
          message: `Stopped after reaching the ${maxSteps}-step limit for one turn. Reply to continue.`,
        };
      } catch {
        // The caller's stream already surfaced the run failure; the notice is
        // best-effort and must never replace or mask that error.
        return undefined;
      }
    },
  };
}
