/**
 * A prompt that did not fit is recoverable — exactly once.
 *
 * Two things are pinned here and they are different in kind. The classifier is a
 * pattern set, and what matters about it is the line it draws: a provider saying
 * "your prompt is too big" must be told apart from a provider saying "you are
 * asking too often", because the answers are opposite — compact and continue
 * versus back off and stop. Bedrock formats a throttle as "Too many tokens,
 * please wait", which reads as an overflow to anyone matching on words alone, and
 * a turn that "recovers" from a rate limit by summarizing and calling again has
 * turned one 429 into two.
 *
 * The retry is the other half, and its whole design is in one sentence: the
 * second attempt CONTINUES the first. Every tool call the failed attempt made
 * went through `turn.tools.call()` and committed a real effect — a transfer, a
 * file, a build — so a retry that replays them performs each one twice. What the
 * first attempt produced therefore rides the next prompt verbatim, below the
 * compaction, and the only thing that changes between the two attempts is how
 * much history the projection carries.
 */
import type { HarnessEvent, ToolRegistry, Turn } from "@vendoai/core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { isContextOverflow } from "./overflow.js";
import { vendo } from "./vendo.js";
import { createTurnState } from "../harness-state.js";
import { createTurnTools } from "../turn-tools.js";
import {
  boundRegistry,
  ctx,
  readTool,
  seats,
  testGuard,
  testSkills,
  testWorkspace,
  textTurn,
  toolCallTurn,
  userMessage,
  ZERO_USAGE,
} from "../test-doubles.test-util.js";

// ── the classifier ───────────────────────────────────────────────────────────

/**
 * One real sentence per ported pattern, in pi-mono's own order
 * (`packages/ai/src/utils/overflow.ts:37-63`). The examples are the ones pi
 * documents above the set, so this table is also the audit trail: 25 entries,
 * 25 patterns.
 */
const OVERFLOW_MESSAGES: Record<string, string> = {
  anthropic: "prompt is too long: 213462 tokens > 200000 maximum",
  "anthropic-413": '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
  bedrock: "Input is too long for requested model.",
  openai: "Your input exceeds the context window of this model",
  litellm: "Requested token count exceeds the model's maximum context length of 131072 tokens",
  gemini: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
  xai: "This model's maximum prompt length is 131072 but the request contains 537812 tokens",
  groq: "Please reduce the length of the messages or completion",
  openrouter: "This endpoint's maximum context length is 131072 tokens. However, you requested about 537812 tokens",
  poolside: "Input length 265330 exceeds the maximum allowed input length of 262144 tokens.",
  together: "The input (265330 tokens) is longer than the model's context length (262144 tokens).",
  copilot: "prompt token count of 145000 exceeds the limit of 128000",
  "llama-cpp": "the request exceeds the available context size, try increasing it",
  "lm-studio": "tokens to keep from the initial prompt is greater than the context length",
  minimax: "invalid params, context window exceeds limit",
  kimi: "Your request exceeded model token limit: 262144 (requested: 300000)",
  mistral: "Prompt contains 300000 tokens, too large for model with 131072 maximum context length",
  ds4: "Prompt has 300,000 tokens, but the configured context size is 131,072 tokens",
  "z-ai": "model_context_window_exceeded",
  ollama: "prompt too long; exceeded max context length by 4096 tokens",
  dashscope: "Range of input length should be [1, 129024]",
  "generic-context-length": "context_length_exceeded",
  "generic-too-many-tokens": "too many tokens in the request",
  "generic-token-limit": "token limit exceeded",
  cerebras: "400 status code (no body)",
};

/**
 * The exclusion set, and it is not decoration: the first three sentences below
 * each match an OVERFLOW pattern as well. Without the guard, a throttled Bedrock
 * call and a rate-limited proxy would both be answered by summarizing the thread
 * and calling the provider straight back.
 */
const NON_OVERFLOW_MESSAGES: Record<string, string> = {
  "bedrock-throttle": "Throttling error: Too many tokens, please wait before trying again.",
  "bedrock-unavailable": "Service unavailable: too many tokens",
  "rate-limited-proxy": "Rate limit reached: token limit exceeded for this minute",
  "http-429": "429 Too Many Requests",
  quota: "You exceeded your current quota, please check your plan and billing details.",
};

describe("isContextOverflow — the prompt did not fit", () => {
  it("covers every ported provider sentence", () => {
    expect(Object.keys(OVERFLOW_MESSAGES)).toHaveLength(25);
  });

  it.each(Object.entries(OVERFLOW_MESSAGES))("reads %s's overflow as an overflow", (_provider, message) => {
    expect(isContextOverflow(new Error(message))).toBe(true);
  });

  it.each(Object.entries(NON_OVERFLOW_MESSAGES))("never reads %s as an overflow", (_case, message) => {
    expect(isContextOverflow(new Error(message))).toBe(false);
  });

  it("reads a bare string as well as an Error, because `error` parts carry both", () => {
    expect(isContextOverflow("prompt is too long: 213462 tokens > 200000 maximum")).toBe(true);
    expect(isContextOverflow("the model refused")).toBe(false);
  });

  it("says no to anything with no words in it", () => {
    expect(isContextOverflow(undefined)).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow({ status: 400 })).toBe(false);
  });
});

// ── the retry ────────────────────────────────────────────────────────────────

type StreamChunks = ReturnType<typeof textTurn>;

/** One step of a scripted attempt: the chunks the provider streams, or the error
 *  it throws instead of streaming anything. */
type ScriptedStep = StreamChunks | Error;

const OVERFLOW = (): Error => new Error("prompt is too long: 213462 tokens > 200000 maximum");

/**
 * A seat that can FAIL mid-turn.
 *
 * `doStream` walks the script one provider call at a time — the loop's steps and
 * the retry's steps share the same counter, which is exactly what makes "how many
 * calls did this turn cost" answerable. `doGenerate` answers the summarizer, so a
 * forced compaction has something to run on.
 */
function overflowSeat(script: readonly ScriptedStep[], summary = "## Goal\nEverything that came before.") {
  const prompts: unknown[] = [];
  let streamCalls = 0;
  let generateCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      generateCalls += 1;
      return {
        content: [{ type: "text" as const, text: summary }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
    doStream: async (request) => {
      prompts.push(structuredClone(request.prompt));
      const next = script[streamCalls];
      streamCalls += 1;
      if (next === undefined) throw new Error("seat exhausted");
      if (next instanceof Error) throw next;
      return { stream: simulateReadableStream({ chunks: next }) };
    },
  });
  return {
    model: model as unknown as LanguageModel,
    /** What each provider call actually sent. */
    prompts,
    streamCalls: () => streamCalls,
    generateCalls: () => generateCalls,
  };
}

const NO_TOOLS: ToolRegistry = {
  descriptors: async () => [],
  execute: async () => ({ status: "error", error: { code: "not-found", message: "no tools" } }),
};

/** Drive the harness directly: the runtime is proven separately, so the Turn is
 *  assembled by hand and the events are collected raw. */
async function driveTurn(options: {
  model: LanguageModel;
  registry?: ToolRegistry;
  messages?: Turn["messages"];
  signal?: AbortSignal;
  harness?: ReturnType<typeof vendo>;
}): Promise<HarnessEvent[]> {
  const turnTools = createTurnTools({
    registry: options.registry ?? NO_TOOLS,
    guard: testGuard(),
    ctx: ctx(),
    interactive: true,
    mirror: () => {},
  });
  const turn: Turn = {
    messages: options.messages ?? [userMessage("m1", "move the money")],
    tools: turnTools,
    skills: testSkills(),
    workspace: testWorkspace(),
    models: seats(options.model),
    state: createTurnState(undefined),
    options: {},
    signal: options.signal ?? new AbortController().signal,
    interactive: true,
  };
  const events: HarnessEvent[] = [];
  for await (const event of (options.harness ?? vendo()).run(turn)) events.push(event);
  turnTools.dispose();
  return events;
}

const texts = (events: HarnessEvent[]): string =>
  events
    .filter((event): event is Extract<HarnessEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.delta)
    .join("");

const errors = (events: HarnessEvent[]): HarnessEvent[] =>
  events.filter((event) => event.type === "error");

/** A thread big enough that the compaction has something above the preserved
 *  tail to summarize (`PRESERVE_RECENT_TOKENS` is 20k), and still small enough
 *  that the trigger never fires on its own against the default 128k window. */
const ANCHOR = "the January transfer came from Checking 4021";
const bigThread = (): Turn["messages"] => [
  userMessage("m1", ANCHOR),
  userMessage("m2", `and now: ${"x".repeat(90_000)}`),
];

describe("a mid-turn overflow compacts and retries once", () => {
  it("recovers silently: the user sees the answer, never the failure", async () => {
    const seat = overflowSeat([OVERFLOW(), textTurn("All set.")]);

    const events = await driveTurn({ model: seat.model });

    expect(seat.streamCalls()).toBe(2);
    expect(texts(events)).toBe("All set.");
    expect(errors(events)).toEqual([]);
  });

  it("carries what the first attempt already did, and never re-runs it", async () => {
    const registry = boundRegistry(
      { maple_transfer_create: { descriptor: readTool("maple_transfer_create", "write"), execute: () => ({ ok: true }) } },
      testGuard(),
    );
    const seat = overflowSeat([
      // Attempt 0, step 1: a real guarded write commits.
      toolCallTurn("maple_transfer_create", { amount: 40 }, "call_1"),
      // Attempt 0, step 2: the prompt the tool result grew no longer fits.
      OVERFLOW(),
      // Attempt 1: the turn continues from there.
      textTurn("Transfer done."),
    ]);

    const events = await driveTurn({ model: seat.model, registry });

    expect(seat.streamCalls()).toBe(3);
    expect(texts(events)).toBe("Transfer done.");
    // ONCE. The retry re-sends the call and its result as history; replaying it
    // would move the money twice.
    expect(registry.invocations.maple_transfer_create).toBe(1);
    const retryPrompt = JSON.stringify(seat.prompts[2]);
    expect(retryPrompt).toContain("call_1");
    expect(retryPrompt).toContain("maple_transfer_create");
  });

  it("forces the compaction the estimate never asked for", async () => {
    const seat = overflowSeat([OVERFLOW(), textTurn("Done.")]);

    await driveTurn({ model: seat.model, messages: bigThread() });

    // Attempt 0 was under the trigger, so it summarized nothing and sent the
    // thread whole; attempt 1 summarized because the provider had already said no.
    expect(JSON.stringify(seat.prompts[0])).toContain(ANCHOR);
    expect(seat.generateCalls()).toBe(1);
    const retryPrompt = JSON.stringify(seat.prompts[1]);
    expect(retryPrompt).toContain("Everything that came before.");
    expect(retryPrompt).not.toContain(ANCHOR);
  });

  it("gives up after the second failure: one compaction, no third call", async () => {
    const seat = overflowSeat([OVERFLOW(), OVERFLOW()]);

    const events = await driveTurn({ model: seat.model, messages: bigThread() });

    expect(seat.streamCalls()).toBe(2);
    expect(seat.generateCalls()).toBe(1);
    expect(errors(events)).toHaveLength(1);
  });

  it("never retries a throttle, however much it sounds like one", async () => {
    const seat = overflowSeat([new Error("Throttling error: Too many tokens, please wait before trying again.")]);

    const events = await driveTurn({ model: seat.model });

    expect(seat.streamCalls()).toBe(1);
    expect(errors(events)).toHaveLength(1);
  });

  it("never retries a turn whose caller has hung up", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCalls += 1;
        controller.abort();
        throw OVERFLOW();
      },
    }) as unknown as LanguageModel;

    const events = await driveTurn({ model, signal: controller.signal });

    expect(streamCalls).toBe(1);
    // An abandoned turn stops cleanly and says nothing — it does not pay for a
    // summarizer and a second attempt nobody is listening to.
    expect(events).toEqual([]);
  });
});
