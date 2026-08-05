/**
 * Token-budgeted compaction (§4.1 item 2).
 *
 * The ORDER of shedding is the contract, not an implementation detail. Reasoning
 * is never re-read by the model after the step that produced it; an old tool
 * payload has already been summarised into the words around it; a dropped
 * message loses something later turns refer to. So each band is asserted on its
 * own — an implementation that jumped straight to dropping the oldest messages
 * would satisfy "fits the budget" and fail every test below it.
 *
 * The window this replaces was a message-COUNT tail slice, which is the wrong
 * unit: twelve one-line messages and twelve 40KB tool results are the same
 * number and nothing like the same prompt.
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import { turnModelMessages } from "./loop.js";

const REASONING = `R${"e".repeat(4000)}`;
const TOOL_OUTPUT = `T${"o".repeat(4000)}`;
const OLDEST = "the oldest question";
const NEWEST = "the newest question";

/** A thread with all three sheddable kinds in it, newest last. */
const thread = (): UIMessage[] => [
  { id: "m1", role: "user", parts: [{ type: "text", text: OLDEST }] },
  {
    id: "m2",
    role: "assistant",
    parts: [
      { type: "reasoning", text: REASONING },
      { type: "text", text: "Let me look." },
    ],
  } as unknown as UIMessage,
  {
    id: "m3",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "dump",
      toolCallId: "c1",
      state: "output-available",
      input: {},
      output: { rows: TOOL_OUTPUT },
    }],
  } as unknown as UIMessage,
  { id: "m4", role: "assistant", parts: [{ type: "text", text: "Found some." }] },
  { id: "m5", role: "user", parts: [{ type: "text", text: NEWEST }] },
];

const wire = (messages: ModelMessage[]): string => JSON.stringify(messages);

/** Every prompt must still be sendable: a system prompt, then at least the ask. */
function expectSendable(messages: ModelMessage[]): void {
  expect(messages[0]?.role).toBe("system");
  expect(messages.at(-1)?.role).toBe("user");
  expect(wire(messages)).toContain(NEWEST);
}

describe("token-budgeted compaction", () => {
  it("sheds nothing at all when the thread already fits", async () => {
    const generous = await turnModelMessages(thread(), "system", undefined, 100_000);
    const unbudgeted = await turnModelMessages(thread(), "system", undefined);
    expect(wire(generous)).toBe(wire(unbudgeted));
  });

  it("sheds REASONING first, and nothing else", async () => {
    const shed = await turnModelMessages(thread(), "system", undefined, 1_500);
    const raw = wire(shed);
    expect(raw).not.toContain(REASONING);
    // Everything cheaper to keep is still here — this is the whole point of an
    // ordered shed rather than a tail slice.
    expect(raw).toContain(TOOL_OUTPUT);
    expect(raw).toContain(OLDEST);
    expect(raw).toContain("Let me look.");
    expectSendable(shed);
  });

  it("sheds OLD TOOL PAYLOADS second, keeping the words around them", async () => {
    const shed = await turnModelMessages(thread(), "system", undefined, 400);
    const raw = wire(shed);
    expect(raw).not.toContain(REASONING);
    expect(raw).not.toContain(TOOL_OUTPUT);
    // The conversation itself survives a shed of its tool payloads.
    expect(raw).toContain(OLDEST);
    expect(raw).toContain("Found some.");
    expectSendable(shed);
  });

  it("drops the OLDEST messages only as a last resort", async () => {
    const shed = await turnModelMessages(thread(), "system", undefined, 10);
    const raw = wire(shed);
    expect(raw).not.toContain(OLDEST);
    // Under any budget the ask survives: a turn with no user message is not a
    // cheaper turn, it is a broken one.
    expectSendable(shed);
  });

  it("leaves a tool call and its result PAIRED whatever it sheds", async () => {
    // An assistant tool-call whose result was pruned is a malformed prompt every
    // provider rejects, so the pair is shed together or not at all.
    for (const budget of [100_000, 1_500, 400, 10]) {
      const shed = await turnModelMessages(thread(), "system", undefined, budget);
      const calls = shed.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part) => part.type === "tool-call" || part.type === "tool-result"));
      expect(calls.length % 2, `budget ${budget}`).toBe(0);
    }
  });

  it("keeps the message-count window working untouched", async () => {
    // Back-compat: `historyWindow` is a shipped host knob and its meaning does
    // not change because a budget joined it.
    const windowed = await turnModelMessages(thread(), "system", 1);
    expect(wire(windowed)).toContain(NEWEST);
    expect(wire(windowed)).not.toContain(OLDEST);
  });
});
