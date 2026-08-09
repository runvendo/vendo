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
import { turnModelMessages } from "../../src/vendo/loop.js";

const REASONING = `R${"e".repeat(4000)}`;
const TOOL_OUTPUT = `T${"o".repeat(4000)}`;
const OLDEST = "the oldest question";
const NEWEST = "the newest question";
/** Enough bulk that a budget can land between the shed's bands. */
const FILLER = "x".repeat(2000);

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

/**
 * The same thread carrying an UNANSWERED tool call — an approval the previous
 * turn abandoned, a step a crash cut short. `runtime.ts:294-300` flips those
 * parts upstream today for exactly this reason: the projection would otherwise
 * hand the provider a tool-call with no tool-result, which is a 400.
 */
const threadWithDanglingCall = (): UIMessage[] => [
  { id: "d1", role: "user", parts: [{ type: "text", text: `${OLDEST} ${FILLER}` }] },
  {
    id: "d2",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "dump",
      toolCallId: "c1",
      state: "input-available",
      input: { q: FILLER },
    }],
  } as unknown as UIMessage,
  {
    id: "d3",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "dump",
      toolCallId: "c2",
      state: "output-available",
      input: {},
      output: { rows: TOOL_OUTPUT },
    }],
  } as unknown as UIMessage,
  { id: "d4", role: "assistant", parts: [{ type: "text", text: "Found some." }] },
  { id: "d5", role: "user", parts: [{ type: "text", text: NEWEST }] },
];

const wire = (messages: ModelMessage[]): string => JSON.stringify(messages);

/** Every part a `ModelMessage` can carry. `flatMap` cannot pick one element type
 *  out of the per-role content union on its own. */
type ContentPart = Exclude<ModelMessage["content"], string>[number];

/**
 * The two prompts every provider rejects outright: a tool-call whose result is
 * missing (or a result whose call is), and a prompt whose first non-system
 * message is the assistant's. Both are reachable from the shed above, because
 * its last band drops from the FRONT.
 */
function expectWellFormed(messages: ModelMessage[], where: string): void {
  const parts = messages.flatMap((message): readonly ContentPart[] =>
    typeof message.content === "string" ? [] : message.content);
  const called = parts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId);
  const answered = parts.filter((part) => part.type === "tool-result").map((part) => part.toolCallId);
  expect([...called].sort(), `tool pairs, ${where}`).toEqual([...answered].sort());
  expect(messages.find((message) => message.role !== "system")?.role, `first non-system, ${where}`)
    .toBe("user");
}

/** Every prompt must still be sendable: a system prompt, then at least the ask. */
function expectSendable(messages: ModelMessage[]): void {
  expect(messages[0]?.role).toBe("system");
  expect(messages.at(-1)?.role).toBe("user");
  expect(wire(messages)).toContain(NEWEST);
}

describe("token-budgeted compaction", () => {
  it("sheds nothing at all when the thread already fits", async () => {
    const { messages: generous } = await turnModelMessages({
      messages: thread(), system: "system", tokenBudget: 100_000,
    });
    const { messages: unbudgeted } = await turnModelMessages({ messages: thread(), system: "system" });
    expect(wire(generous)).toBe(wire(unbudgeted));
  });

  it("sheds REASONING first, and nothing else", async () => {
    // 3,000 rather than 1,500: the budget is denominated in the engine's ONE
    // conversion, which is now two characters per token instead of four. Same
    // band shed, same claim — the units under it changed.
    const { messages: shed } = await turnModelMessages({
      messages: thread(), system: "system", tokenBudget: 3_000,
    });
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
    const { messages: shed } = await turnModelMessages({
      messages: thread(), system: "system", tokenBudget: 400,
    });
    const raw = wire(shed);
    expect(raw).not.toContain(REASONING);
    expect(raw).not.toContain(TOOL_OUTPUT);
    // The conversation itself survives a shed of its tool payloads.
    expect(raw).toContain(OLDEST);
    expect(raw).toContain("Found some.");
    expectSendable(shed);
  });

  it("drops the OLDEST messages only as a last resort", async () => {
    const { messages: shed } = await turnModelMessages({
      messages: thread(), system: "system", tokenBudget: 10,
    });
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
      const { messages: shed } = await turnModelMessages({
        messages: thread(), system: "system", tokenBudget: budget,
      });
      const calls = shed.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part) => part.type === "tool-call" || part.type === "tool-result"));
      expect(calls.length % 2, `budget ${budget}`).toBe(0);
    }
  });

  it("projects a well-formed prompt across the band-2 cliff", async () => {
    // The cliff this walks, measured on the fixture: 2_500 still fits whole,
    // 2_000 has shed the tool payloads, and somewhere between 600 and 500 the
    // shed starts dropping the oldest messages. Pair parity alone (the test
    // above) cannot see either defect: the dangling call is orphaned before any
    // budget applies, and the assistant-first prompt is perfectly paired.
    for (const budget of [100_000, 2_500, 2_000, 1_000, 600, 500, 200, 10]) {
      const { messages: shed } = await turnModelMessages({
        messages: threadWithDanglingCall(), system: "system", tokenBudget: budget,
      });
      expectWellFormed(shed, `budget ${budget}`);
      expect(wire(shed), `budget ${budget}`).toContain(NEWEST);
    }
    // …and the walk really did cross the cliff, so this can never pass on a
    // thread that never sheds a message at all.
    const { messages: floor } = await turnModelMessages({
      messages: threadWithDanglingCall(), system: "system", tokenBudget: 10,
    });
    expect(wire(floor)).not.toContain(OLDEST);
  });

  it("keeps the message-count window working untouched", async () => {
    // Back-compat: `historyWindow` is a shipped host knob and its meaning does
    // not change because a budget joined it.
    const { messages: windowed } = await turnModelMessages({
      messages: thread(), system: "system", historyWindow: 1,
    });
    expect(wire(windowed)).toContain(NEWEST);
    expect(wire(windowed)).not.toContain(OLDEST);
  });
});
