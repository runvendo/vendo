/**
 * The turn loop — ONE implementation, every caller.
 *
 * This is the `streamText` call that used to live inside `createAgent`'s
 * `createUIMessageStream` closure, lifted out verbatim so it can also be driven
 * by a `Harness` (`vendo()`, its neighbour in this folder). Extracting it is what
 * makes the harness a genuine lift rather than a parallel reimplementation: every
 * rail here — the step cap, `buildFailedStop`, the history window, the cache
 * breakpoints, the abandoned-approval provider rewrite, the tool-search loadout —
 * is shared, so a rail can only be dropped by deleting it for BOTH callers.
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
  otelTelemetry,
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
import {
  compactContext,
  estimatePromptTokens,
  findCutIndex,
  PRESERVE_RECENT_TOKENS,
  shouldCompact,
  summaryMessage,
  tokensFor,
  triggerTokens,
  type CompactionConfig,
  type CompactionState,
} from "./compaction.js";
import { failoverModel, type ResolvedModel } from "./failover.js";
import type { ToolSearchSession } from "../tool-search.js";

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

/** The messages' own share of a prompt, in the ONE conversion
 *  ({@link tokensFor}) every rail here is denominated in. This is what the shed
 *  can reach; the system prompt and the tools block are in the figure it is
 *  charged against and are not sheddable. */
function estimateTokens(messages: readonly ModelMessage[]): number {
  return tokensFor(JSON.stringify(messages).length);
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
 *
 * `promptTokens` is what the WHOLE prompt costs, and it is the caller's to
 * supply — it is the same figure the caller's own rail decided on, so
 * `fits(messages)` is exactly the negation of the trigger that called and the two
 * cannot disagree about the prompt they are both looking at. This used to be
 * re-derived here, in a second conversion, while the trigger tripped on the
 * provider's reported count: 308,000 characters of dense statement text bill
 * 142,890 real tokens and used to estimate 78,244, so the trigger said "over the
 * budget" and this said "fits" about the same prompt and neither rail did
 * anything. There is one conversion now ({@link tokensFor}) and one measurement
 * per turn, which is why the credit below is in the same units as the charge.
 *
 * The tools block rides inside whatever figure the caller passed, and it is not
 * sheddable, so it raises where the shed STARTS and never what the shed can
 * reach. Once the messages are gone the floor stops, still over budget, and
 * says so by returning what is left rather than by pretending.
 */
function shedToBudget(
  messages: readonly ModelMessage[],
  budget: number,
  promptTokens: number,
): ModelMessage[] {
  const whole = estimateTokens(messages);
  const fits = (candidate: readonly ModelMessage[]): boolean =>
    promptTokens - (whole - estimateTokens(candidate)) <= budget;
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
 * Well-formedness, applied to EVERY projection whatever produced it.
 *
 * Two prompts a provider rejects outright, and this file can build both. A
 * tool-call whose result is missing (or a result whose call is): the window
 * slice above cannot cause it, but a part left at `input-available` by an
 * abandoned approval arrives that way from the conversion — which is why
 * `runtime.ts` has to flip those parts upstream before the projection ever runs.
 * And a prompt whose first non-system message is the assistant's: {@link
 * shedToBudget}'s last band drops from the FRONT, so it walks into one the
 * moment a budget lands mid-history.
 *
 * Fixing it here rather than at each caller is the point: a projection is the
 * only thing the provider sees, so well-formedness is a property of the
 * projection, not a courtesy each producer has to remember.
 */
function wellFormed(messages: readonly ModelMessage[]): ModelMessage[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") called.add(part.toolCallId);
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  const paired = messages.flatMap<ModelMessage>((message) => {
    if (typeof message.content === "string") return [message];
    const content = message.content.filter((part) => {
      if (part.type === "tool-call") return answered.has(part.toolCallId);
      if (part.type === "tool-result") return called.has(part.toolCallId);
      return true;
    });
    // A message that was nothing but an orphan is no longer a message.
    if (content.length === 0) return [];
    return [{ ...message, content } as ModelMessage];
  });
  // The ask always survives (see {@link shedToBudget}), so there is normally a
  // user message to anchor on; a history with none at all cannot be repaired by
  // dropping more of it, so it is left alone for the caller's error to be the
  // one that surfaces.
  const firstUser = paired.findIndex((message) => message.role === "user");
  if (firstUser === -1) return paired;
  const firstNonSystem = paired.findIndex((message) => message.role !== "system");
  return [...paired.slice(0, firstNonSystem), ...paired.slice(firstUser)];
}

/**
 * What the loop is asked to do about a window it now knows the size of.
 *
 * `contextWindowTokens` and the two ratios come from {@link CompactionConfig};
 * the rest is the turn's own: which seat summarizes, what the thread already
 * remembers, and whether the caller is past asking.
 */
export interface TurnCompaction extends CompactionConfig {
  model: LanguageModel;
  state?: CompactionState;
  /** Compact whatever the estimate says — the overflow retry's re-entry. */
  force?: boolean;
}

/**
 * One turn's prompt inputs. This was four positionals; the shipment's window
 * table, compaction and overflow retry add three more, and a seventh positional
 * is unreadable at the call site — so the shape is declared once, whole, before
 * three slices fill it.
 *
 * BREAKING: `turnModelMessages` is public (`vendo/index.ts`).
 */
export interface TurnPromptInput {
  messages: UIMessage[];
  system: string;
  /** The live toolset, so the trigger can count the tools block. */
  tools?: ToolSet;
  historyWindow?: number;
  tokenBudget?: number;
  compaction?: TurnCompaction;
  /** Model messages this turn ALREADY produced: appended after the projection
   *  and never summarized, so a retry CONTINUES the turn instead of re-running
   *  its tool calls — each one a real guarded effect. */
  resume?: readonly ModelMessage[];
  /** The turn's own signal. Building a projection is normally pure, but the
   *  summarizer pass is a provider call, and a caller that hung up before the
   *  first token must not keep paying for one (AGENT-3). */
  signal?: AbortSignal;
}

export interface TurnPrompt {
  messages: ModelMessage[];
  /** Carried out as DATA, because the loop does not know where the caller's
   *  state slot is. Written by the summarizer, and carrying the boundary the next
   *  turn rebuilds this same projection from. */
  compacted?: CompactionState;
}

/**
 * Which of `history` the thread's stored summary has ALREADY absorbed.
 *
 * Three outcomes, and the middle one is the reason this is a function:
 *  - the boundary is IN this window: the summary covers everything up to it, so
 *    the tail is what follows and the summary stands in for the rest;
 *  - the boundary is older than the window but still in the thread: the host's
 *    slice already dropped the covered band, so the whole window is tail and the
 *    summary still stands in front of it. It is not a duplicate — it accounts for
 *    messages this prompt does not carry;
 *  - the boundary is nowhere in the thread (rewound, edited, or a row written by
 *    a build that had no boundary at all): the summary describes history that no
 *    longer exists, so it is DISCARDED and the turn measures the whole transcript.
 *    That errs toward compacting, which is the direction that cannot ship a
 *    prompt the provider rejects.
 */
function resolveBoundary(
  state: CompactionState | undefined,
  history: readonly UIMessage[],
  thread: readonly UIMessage[],
): { summary?: string; tail: readonly UIMessage[] } {
  const summary = state?.summary;
  const boundary = state?.boundaryMessageId;
  if (summary === undefined || summary === "" || boundary === undefined) return { tail: history };
  const index = history.findIndex((message) => message.id === boundary);
  if (index !== -1) return { summary, tail: history.slice(index + 1) };
  if (thread.some((message) => message.id === boundary)) return { summary, tail: history };
  return { tail: history };
}

/**
 * The provider messages for one turn: the system prompt, the summary standing in
 * for the band it absorbed, the verbatim tail that follows it, and the cache
 * breakpoints that keep a growing thread from re-billing.
 *
 * The ORDER is the mechanism. The candidate prompt is REBUILT first — summary
 * plus the messages the summary never read — and only then measured. Measuring the
 * stored transcript instead is what made a thread whose bulk is one huge paste pay
 * a summarizer pass on every single turn: that number is permanently over the
 * trigger, so the trigger fired forever and the summarizer re-read the whole paste
 * each time, for about what simply sending it would have cost.
 */
export async function turnModelMessages(input: TurnPromptInput): Promise<TurnPrompt> {
  const { messages, system, historyWindow, tokenBudget, compaction, resume } = input;
  // History windowing: bound what is re-sent per turn to the last N whole messages.
  // Slicing whole UIMessages keeps each turn's tool-call/result pairing intact.
  const history = historyWindow !== undefined && messages.length > historyWindow
    ? messages.slice(-historyWindow)
    : messages;
  // What the thread already paid to have summarized, and what it did not.
  const resolved = resolveBoundary(compaction?.state, history, messages);
  let summary = resolved.summary;
  let tail = resolved.tail;
  const convert = async (band: readonly UIMessage[]): Promise<ModelMessage[]> =>
    (await convertToModelMessages(providerHistory([...band]))).filter((message) => message.content.length > 0);
  let converted = await convert(tail);
  /** The candidate this turn would send: the summary is part of the prompt, so it
   *  is part of what the prompt costs. */
  const projected = (): ModelMessage[] =>
    summary === undefined ? converted : [summaryMessage(summary), ...converted];
  // THE measurement, taken fresh wherever a rail needs it and never carried: the
  // prompt about to be sent — system, messages AND the tools block, the part that
  // never shrinks — in the one conversion every rail here shares.
  const promptTokens = (): number =>
    estimatePromptTokens({ system, messages: projected(), tools: input.tools ?? {} });
  // Budgeting runs on the CONVERTED form because that is the form the provider
  // bills, and it runs before the breakpoints below because shedding changes
  // which message is the stable prefix's last one.
  if (tokenBudget !== undefined) converted = shedToBudget(converted, tokenBudget, promptTokens());
  // The window the model actually has, against the prompt this turn is actually
  // sending. The host's own `historyWindow` slice is already applied above and is
  // not negotiable (Q2b): what the host cut is gone, and this decides about what
  // is left.
  let compacted: CompactionState | undefined;
  if (compaction !== undefined) {
    const tripped = promptTokens();
    // `force` is the overflow retry's re-entry: the provider has already said no,
    // so the estimate has nothing left to decide.
    if (compaction.force === true || shouldCompact(tripped, compaction)) {
      // The cut, in UIMessage space, so the boundary it produces is an id the
      // thread can store and the next turn can re-resolve.
      const cut = findCutIndex(tail, compaction.preserveRecentTokens ?? PRESERVE_RECENT_TOKENS);
      // ONE pass, on the thread's own seat, at the start of the turn. Its own
      // failure is not the turn's: a summarizer that 500s, times out or refuses
      // leaves the shed underneath, which is the entire reason the shed stayed.
      // Nothing above the tail (`cut === 0`) means summarizing would spend a call
      // and project a LONGER prompt than the one it was asked to shrink.
      const result = cut === 0 ? undefined : await compactContext({
        messages: await convert(tail.slice(0, cut)),
        model: compaction.model,
        config: compaction,
        ...(summary === undefined ? {} : { summary }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }).catch(() => undefined);
      if (result === undefined || result.summary === "") {
        // The floor. Drops reasoning, then tool payloads, then the oldest
        // messages, with no summary and no notice to the model. It is handed the
        // SAME figure the trigger just tripped on, so the two cannot disagree
        // about the prompt they are both looking at. A trip the tools block alone
        // caused sheds the history and then stops, still over budget — the old
        // floor charged the messages against the WHOLE window and so quietly shed
        // nothing at all in that case, which is the same blindness one layer down.
        converted = shedToBudget(converted, triggerTokens(compaction), tripped);
      } else {
        // One pass folded `tail[0..cut)` into whatever the summary already held, so
        // the boundary moves to the newest message that pass read.
        const absorbed = (tail[cut - 1] as UIMessage).id;
        summary = result.summary;
        tail = tail.slice(cut);
        converted = await convert(tail);
        compacted = { version: 1, summary: result.summary, boundaryMessageId: absorbed };
      }
    }
  }
  // The summary is part of the prompt from here down, exactly as it was part of
  // every measurement above.
  converted = projected();
  // What this turn has ALREADY produced, appended after everything the projection
  // decided: never summarized and never shed, because each tool call in it is a
  // real guarded effect that a re-run would perform twice.
  if (resume !== undefined && resume.length > 0) converted = [...converted, ...resume];
  // Whatever the window, the summary and the shed left behind, the prompt still
  // has to be one a provider will accept — and this is the last place that is
  // knowable.
  converted = wellFormed(converted);
  // Cache the stable history prefix (everything but the final message) alongside the
  // static system prompt below, so Anthropic re-reads the cached prefix instead of
  // re-billing the whole growing thread each turn.
  if (converted.length >= 2) {
    const prefixEnd = converted[converted.length - 2] as ModelMessage;
    prefixEnd.providerOptions = { ...prefixEnd.providerOptions, ...CACHE_BREAKPOINT };
  }
  return {
    messages: [
      { role: "system", content: system, providerOptions: CACHE_BREAKPOINT },
      ...converted,
    ],
    ...(compacted === undefined ? {} : { compacted }),
  };
}

/**
 * Move the trailing cache breakpoint to the END of the prompt a step is about to
 * send.
 *
 * {@link turnModelMessages} marks the history prefix once, before the first step.
 * That is the right prefix for a one-step turn and the wrong one for every turn
 * after it: each step appends its own assistant message and tool results to the
 * same prompt, so from step two onward the growing tail sits outside the cached
 * prefix and is re-billed in full on every remaining step. A ten-step build turn
 * is where the context actually lives, and it was the turn paying the most.
 *
 * Stripping first is not tidiness. Anthropic honours four breakpoints, so a run
 * that only ever ADDED would quietly lose its oldest — the system prompt — around
 * step three. Leading system messages are the one thing this never touches: their
 * marker (see {@link CACHE_BREAKPOINT}) covers the static prefix that every step
 * shares, including whatever a later slice projects between it and the tail.
 */
function advanceCacheBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
  const stripped = messages.map((message) => {
    if (message.role === "system") return message;
    const anthropic = message.providerOptions?.anthropic;
    if (anthropic?.cacheControl === undefined) return message;
    const { cacheControl: _moved, ...kept } = anthropic;
    return { ...message, providerOptions: { ...message.providerOptions, anthropic: kept } } as ModelMessage;
  });
  const last = stripped.at(-1);
  // A prompt that is nothing but the system message has no tail to mark, and its
  // marker is already where it belongs.
  if (last === undefined || last.role === "system") return stripped;
  stripped[stripped.length - 1] = {
    ...last,
    providerOptions: { ...last.providerOptions, ...CACHE_BREAKPOINT },
  } as ModelMessage;
  return stripped;
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
  /** Already built and guard-bound by the caller (the harness runtime's
   *  delegating set). */
  tools: ToolSet;
  signal?: AbortSignal;
  /** §3.5 — the turn this loop is running, for anything downstream that has to
   *  name it. Optional only because a caller may drive the loop outside a
   *  composed turn; every composed caller mints one. */
  turnId?: TurnId;
  context?: TurnContext;
  /** Extra stop conditions, COMPOSED with the loop's own three rather than
   *  replacing them. The array used to be a literal, so a caller who needed a
   *  fourth condition had nowhere to put it and would have had to grow a second
   *  stop mechanism beside this one. */
  stopWhen?: readonly StopCondition<ToolSet>[];
  toolSearch?: ToolSearchSession;
  /** The window this turn has, and what the thread already remembers about
   *  filling it. Unset means no window awareness at all — the loop's behaviour
   *  before this shipment. */
  compaction?: TurnCompaction;
  /** Model messages this turn already produced, for a retry that continues it. */
  resume?: readonly ModelMessage[];
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

export interface TurnLoop {
  result: ReturnType<typeof streamText>;
  maxSteps: number;
  /**
   * AGENT-7: exhausting the step cap is VISIBLE. Call after the stream drains —
   * a run that still wanted tool calls after its final permitted step ended
   * because of the cap, not because the model finished.
   */
  stepLimitPart(): Promise<VendoStepLimitPart | undefined>;
  /** What this turn compacted, as DATA for whoever owns the state slot — the
   *  loop does not know where that is. Written by the summarizer. */
  compacted?: CompactionState;
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
  const { messages: modelMessages, compacted } = await turnModelMessages({
    messages: options.messages,
    system: options.system,
    // The live toolset, because the trigger has to count what the prompt
    // actually carries and the tools block is most of it on a curated surface.
    tools: options.tools,
    historyWindow: options.context?.historyWindow,
    tokenBudget: options.context?.contextTokenBudget,
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const { toolSearch } = options;
  const result = streamText({
    model: turnModel(options),
    messages: modelMessages,
    tools: options.tools,
    stopWhen: [stepCountIs(maxSteps), buildFailedStop, askedUserStop, ...(options.stopWhen ?? [])],
    maxOutputTokens: options.context?.maxOutputTokens,
    // Stated rather than inherited — see DEFAULT_MAX_RETRIES.
    maxRetries: options.context?.maxRetries ?? DEFAULT_MAX_RETRIES,
    // Opt-in OTel GenAI spans (VENDO_OTEL_TRACING=1) — the turn is the root
    // span every tool call and generation hangs off, so a host reading its own
    // dashboard sees one tree per turn.
    ...otelTelemetry("vendo.agent.turn"),
    // ENG-252 loadout: restrict what the model may pick to the current loadout.
    // `prepareStep` re-reads it each step so a tool loaded via
    // `vendo_tools_search` becomes callable on the very next step. This gates the
    // model's CHOICE only — every tool still executes through the guard-bound
    // registry, so there is no unguarded path.
    ...(toolSearch === undefined ? {} : { activeTools: toolSearch.activeToolNames() }),
    // One hook, two rails. `prepareStep` used to be built only when a tool-search
    // session existed, which is why a step's growing tool results were never
    // cached — the turn with the most to cache had no hook at all. It is returned
    // on every turn now, and the loadout rides the same result rather than
    // growing a second per-step hook beside it.
    prepareStep: ({ messages }) => ({
      messages: advanceCacheBreakpoint(messages),
      ...(toolSearch === undefined ? {} : { activeTools: toolSearch.activeToolNames() }),
    }),
    // AGENT-3: cancellation reaches the provider call itself; the loop never
    // starts another step once the signal fires.
    abortSignal: options.signal,
  });

  return {
    result,
    maxSteps,
    // DATA out: what this turn compacted, for whoever owns the state slot.
    ...(compacted === undefined ? {} : { compacted }),
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
