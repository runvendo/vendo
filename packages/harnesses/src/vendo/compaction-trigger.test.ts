/**
 * How big the loop thinks its own prompt is, and when that is too big.
 *
 * Three claims, each of which the loop got wrong before this slice:
 *
 * 1. **The tools block counts.** A deployment's toolset is sent in FULL on every
 *    step — names, descriptions and JSON schemas — and on a curated surface it is
 *    routinely tens of thousands of tokens. An estimate over the messages alone
 *    is not an estimate of the prompt; it is an estimate of part of it, and the
 *    part it omits does not shrink.
 * 2. **The provider's own number beats a guess about the same tokens.** Every
 *    turn ends with a `finish-step` carrying `usage.inputTokens` for the whole
 *    prompt. Re-guessing that prefix at four characters per token throws away a
 *    measurement we already paid for; the guess is for the DELTA only.
 * 3. **The trip is at 81%, not at 100%.** A trigger that fires when the window is
 *    full has already lost — the turn that discovers it is the turn that 400s.
 *
 * The interim floor is asserted here too, and it is deliberately shallow: with no
 * summarizer yet, a trip sheds to `contextWindowTokens × triggerRatio`. That
 * budget bounds the MESSAGES, so a trip caused by the tools block alone sheds
 * nothing — the tools are not sheddable and the floor does not pretend otherwise.
 * S3 replaces the trip with a summarizer and demotes this to an emergency floor.
 */
import { jsonSchema, tool, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  estimatePromptTokens,
  shouldCompact,
  PRESERVE_RECENT_TOKENS,
  TRIGGER_RATIO,
} from "./compaction.js";
import { turnModelMessages } from "./loop.js";

const message = (role: "user" | "assistant", text: string): ModelMessage =>
  ({ role, content: [{ type: "text", text }] }) as ModelMessage;

/** A toolset whose SCHEMAS are the bulk, as a real curated surface's are. */
const fatTools = (): ToolSet => ({
  maple_listTransactions: tool({
    description: `List transactions. ${"d".repeat(20_000)}`,
    inputSchema: jsonSchema({
      type: "object",
      properties: { account: { type: "string", description: "x".repeat(20_000) } },
      additionalProperties: false,
    } as never),
    execute: async () => ({}),
  }),
});

describe("the prompt estimate", () => {
  it("COUNTS THE TOOLS BLOCK — the same messages cost more with tools attached", () => {
    const messages = [message("user", "how much did I spend?")];
    const bare = estimatePromptTokens({ system: "system", messages, tools: {} });
    const equipped = estimatePromptTokens({ system: "system", messages, tools: fatTools() });
    // Not "a bit more": the block is ~40k characters, so it is worth ~10k tokens
    // and it is sent on every step of every turn.
    expect(equipped - bare).toBeGreaterThan(9_000);
  });

  it("counts the SYSTEM prompt, which is also part of the same window", () => {
    const messages = [message("user", "hi")];
    const short = estimatePromptTokens({ system: "system", messages, tools: {} });
    const long = estimatePromptTokens({ system: "s".repeat(40_000), messages, tools: {} });
    expect(long - short).toBeGreaterThan(9_000);
  });

  it("uses the PROVIDER's number for the prefix it covers, not a guess", () => {
    // A prefix nobody needs to guess at: 400k characters the provider already
    // priced at 50k tokens. Re-estimating it would report ~100k.
    const covered = [message("user", "a".repeat(200_000)), message("assistant", "b".repeat(200_000))];
    const messages = [...covered, message("user", "and now the newest ask")];
    const guessed = estimatePromptTokens({ system: "system", messages, tools: {} });
    const measured = estimatePromptTokens({
      system: "system",
      messages,
      tools: {},
      lastPromptTokens: 50_000,
      reportedThrough: covered.length,
    });
    expect(guessed).toBeGreaterThan(90_000);
    expect(measured).toBeLessThan(51_000);
    expect(measured).toBeGreaterThan(50_000);
  });

  it("guesses the DELTA the provider has not seen, rather than ignoring it", () => {
    const covered = [message("user", "old")];
    const tail = message("user", "n".repeat(8_000));
    const measured = estimatePromptTokens({
      system: "system",
      messages: [...covered, tail],
      tools: {},
      lastPromptTokens: 50_000,
      reportedThrough: covered.length,
    });
    // ~8k characters of new text is ~2k tokens at four characters each.
    expect(measured - 50_000).toBeGreaterThan(1_800);
    expect(measured - 50_000).toBeLessThan(2_400);
  });

  it("is exactly the provider's number when nothing has been added since", () => {
    const messages = [message("user", "old"), message("assistant", "older")];
    expect(estimatePromptTokens({
      system: "system",
      messages,
      tools: {},
      lastPromptTokens: 50_000,
      reportedThrough: messages.length,
    })).toBe(50_000);
  });

  it("falls back to the whole-prompt guess when no turn has reported yet", () => {
    // The first turn of a thread has no provider number at all.
    const messages = [message("user", "a".repeat(40_000))];
    const first = estimatePromptTokens({ system: "system", messages, tools: {} });
    expect(first).toBeGreaterThan(9_000);
  });
});

describe("the trigger", () => {
  it("carries the ported cline ratios", () => {
    expect(TRIGGER_RATIO).toBe(0.81);
    expect(PRESERVE_RECENT_TOKENS).toBe(20_000);
  });

  it("trips at 81% of the window — NOT at 80%", () => {
    const config = { contextWindowTokens: 100_000 };
    expect(shouldCompact(81_000, config)).toBe(true);
    expect(shouldCompact(80_999, config)).toBe(false);
    expect(shouldCompact(80_000, config)).toBe(false);
  });

  it("lets a host move the ratio without moving the window", () => {
    expect(shouldCompact(50_000, { contextWindowTokens: 100_000, triggerRatio: 0.5 })).toBe(true);
    expect(shouldCompact(50_000, { contextWindowTokens: 100_000 })).toBe(false);
  });
});

/** A thread whose messages alone are worth roughly 10k tokens. */
const thread = (): UIMessage[] => [
  { id: "m1", role: "user", parts: [{ type: "text", text: `OLDEST ${"o".repeat(20_000)}` }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "a".repeat(20_000) }] },
  { id: "m3", role: "user", parts: [{ type: "text", text: "NEWEST" }] },
];

const wire = (messages: ModelMessage[]): string => JSON.stringify(messages);

describe("the loop's interim floor", () => {
  it("sheds to the window when the estimate trips", async () => {
    const { messages } = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      compaction: { model: "probe-model", contextWindowTokens: 2_000 },
    });
    // 0.81 × 2_000 = 1_620 tokens: the oldest goes, the ask never does.
    expect(wire(messages)).not.toContain("OLDEST");
    expect(wire(messages)).toContain("NEWEST");
  });

  it("leaves a turn UNDER the trigger byte-for-byte alone", async () => {
    const roomy = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      compaction: { model: "probe-model", contextWindowTokens: 1_000_000 },
    });
    const untriggered = await turnModelMessages({ messages: thread(), system: "system" });
    expect(wire(roomy.messages)).toBe(wire(untriggered.messages));
  });

  it("still slices `historyWindow` FIRST, then estimates what is left", async () => {
    // Q2b: the host's explicit slice is not advice. A window of 1 leaves one
    // short message, which is nowhere near the trigger — so a trigger that ran
    // on the unsliced thread would shed a prompt that never needed it.
    const { messages } = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      historyWindow: 1,
      compaction: { model: "probe-model", contextWindowTokens: 2_000 },
    });
    expect(wire(messages)).toContain("NEWEST");
    expect(wire(messages)).not.toContain("OLDEST");
    expect(messages.filter((entry) => entry.role !== "system").length).toBe(1);
  });

  it("uses the state's provider number instead of re-guessing the prefix", async () => {
    // Same thread, same window, one difference: the previous turn reported that
    // this prompt cost 100 tokens. The guess says ~10k and would shed; the
    // measurement says it fits, and the measurement is what the provider billed.
    const { messages } = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      compaction: {
        model: "probe-model",
        contextWindowTokens: 2_000,
        state: { version: 1, lastPromptTokens: 100 },
      },
    });
    expect(wire(messages)).toContain("OLDEST");
  });
});
