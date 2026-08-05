/**
 * The turn loop — ONE implementation, two callers.
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
import { ASK_USER_TOOL, VENDO_MAKE_TOOL, VENDO_APP_BUILD_FAILED_PREFIX, type VendoStepLimitPart } from "@vendoai/core";
import {
  convertToModelMessages,
  isToolUIPart,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { ToolSearchSession } from "./tool-search.js";

// AGENT-7: the default agent-loop step cap (unchanged from the previously
// hardcoded value); hosts raise or lower it via context.maxSteps.
export const DEFAULT_MAX_STEPS = 20;

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
 * The provider messages for one turn: the system prompt, the optionally windowed
 * history, and the cache breakpoints that keep a growing thread from re-billing.
 */
export async function turnModelMessages(
  messages: UIMessage[],
  system: string,
  historyWindow: number | undefined,
): Promise<ModelMessage[]> {
  // History windowing: bound what is re-sent per turn to the last N whole messages.
  // Slicing whole UIMessages keeps each turn's tool-call/result pairing intact.
  const history = historyWindow !== undefined && messages.length > historyWindow
    ? messages.slice(-historyWindow)
    : messages;
  const converted = (await convertToModelMessages(providerHistory(history)))
    .filter((message) => message.content.length > 0);
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
  system: string;
  messages: UIMessage[];
  /** Already built and guard-bound by the caller (buildAgentTools, or the
   *  harness runtime's delegating set). */
  tools: ToolSet;
  signal?: AbortSignal;
  context?: {
    maxOutputTokens?: number;
    historyWindow?: number;
    maxSteps?: number;
  };
  toolSearch?: ToolSearchSession;
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
}

export async function startTurn(options: TurnLoopOptions): Promise<TurnLoop> {
  const maxSteps = options.context?.maxSteps ?? DEFAULT_MAX_STEPS;
  const modelMessages = await turnModelMessages(
    options.messages,
    options.system,
    options.context?.historyWindow,
  );
  const { toolSearch } = options;
  const result = streamText({
    model: options.model,
    messages: modelMessages,
    tools: options.tools,
    stopWhen: [stepCountIs(maxSteps), buildFailedStop, askedUserStop],
    maxOutputTokens: options.context?.maxOutputTokens,
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
