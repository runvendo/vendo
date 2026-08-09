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
import { estimatePromptTokens, shouldCompact } from "../../src/vendo/compaction.js";
import { turnModelMessages } from "../../src/vendo/loop.js";

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

  it("OVER-counts dense text rather than under-counting it", () => {
    // The whole reason the ratio is 2 and not cline's 3 or the 4 this shipped
    // with. 308,000 characters of dense statement text is what the walker thread
    // pasted, and the provider billed 142,890 tokens for it: the estimate has to
    // land ABOVE that, because the cheap error is one compaction the thread did
    // not need and the expensive one is a prompt the provider rejects.
    const dense = [message("user", "d".repeat(308_000))];
    expect(estimatePromptTokens({ system: "", messages: dense, tools: {} })).toBeGreaterThan(142_890);
  });

  it("measures THIS prompt and nothing carried — same input, same answer", () => {
    // No history, no state, no previous turn's report. The estimate used to add a
    // stored count to a guess at the delta, and a stored count is a fact about a
    // prompt some earlier turn SENT: after a compaction that is a different size
    // from the thread, which is how the trigger went blind and how it alternated.
    const messages = [message("user", "a".repeat(200_000)), message("assistant", "b".repeat(200_000))];
    const once = estimatePromptTokens({ system: "system", messages, tools: {} });
    const twice = estimatePromptTokens({ system: "system", messages, tools: {} });
    expect(once).toBe(twice);
    // …and it grows with the prompt, monotonically, because it IS the prompt.
    const grown = estimatePromptTokens({
      system: "system",
      messages: [...messages, message("user", "n".repeat(8_000))],
      tools: {},
    });
    expect(grown - once).toBeGreaterThan(3_800);
    expect(grown - once).toBeLessThan(4_400);
  });
});

describe("the trigger", () => {
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

  it("uses the state's SUMMARY instead of re-reading the band it absorbed", async () => {
    // Same thread, same window, one difference: the slot already holds a summary
    // and the boundary it absorbed. What the trigger measures is the prompt that
    // rebuild produces — summary plus the messages the summary never read — so a
    // thread whose bulk is already summarized is no longer over the line, and the
    // summarizer is not called again.
    const { messages, compacted } = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      compaction: {
        model: "probe-model",
        contextWindowTokens: 2_000,
        state: { version: 1, summary: "## Goal\nREUSED ACCOUNT", boundaryMessageId: "m2" },
      },
    });
    expect(wire(messages)).toContain("REUSED ACCOUNT");
    expect(wire(messages)).not.toContain("OLDEST");
    // Nothing compacted, so there is no new state to persist.
    expect(compacted).toBeUndefined();
  });

  it("DISCARDS a summary whose boundary this history does not contain", async () => {
    // The loop's own fallback, asserted at the loop. `vendo()` refuses an
    // unplaceable state before the loop ever sees it, so this rail is only
    // reachable from `createAgent` — the other caller of `startTurn`, which has no
    // slot of its own and passes whatever its host handed it. A boundary that
    // names no message here means the summary describes history this thread does
    // not have, and projecting it would answer from a branch nobody is on.
    const { messages } = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      compaction: {
        model: "probe-model",
        contextWindowTokens: 2_000,
        state: { version: 1, summary: "## Goal\nSTALE ACCOUNT", boundaryMessageId: "m_deleted" },
      },
    });

    expect(wire(messages)).not.toContain("STALE ACCOUNT");
  });

  it("keeps a summary whose boundary the host's WINDOW sliced away", async () => {
    // The case between the two, and the one a plain `findIndex` gets wrong. The
    // boundary is older than the window, so it is not in the projected history —
    // but it IS in the thread, and the band it absorbed is exactly what the host's
    // slice threw away. Dropping the summary here would send a prompt that
    // remembers neither.
    const { messages } = await turnModelMessages({
      messages: thread(),
      system: "system",
      tools: {},
      historyWindow: 1,
      compaction: {
        model: "probe-model",
        contextWindowTokens: 1_000_000,
        state: { version: 1, summary: "## Goal\nSTILL VALID ACCOUNT", boundaryMessageId: "m1" },
      },
    });

    expect(wire(messages)).toContain("STILL VALID ACCOUNT");
    expect(wire(messages)).toContain("NEWEST");
  });
});
