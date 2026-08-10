/**
 * The cached prefix is BYTE-STABLE across the steps of one turn.
 *
 * Marking breakpoints is only half of prompt caching; the other half is that the
 * bytes in front of a breakpoint never move. Anthropic renders a request as
 * `tools` → `system` → `messages` and looks a cache hit up by prefix, so anything
 * that varies per step in front of the moving breakpoint — a re-serialised tool
 * listing, a tool set that grows mid-turn, a timestamp in the brief — turns every
 * step into a full re-prefill: the read collapses and the whole prompt is billed
 * as a cache WRITE on every step. `advanceCacheBreakpoint`'s sibling test proves
 * the markers move; this one proves there is something stable for them to mark.
 *
 * Why the tools block gets its own assertion: it renders FIRST, so a single
 * changed byte there invalidates the system prompt and the entire history behind
 * it. `activeTools` is re-read every step through `prepareStep` (that is how a
 * tool searched in through `find_tools` becomes choosable mid-turn), which makes
 * the per-step tools block the one input this loop deliberately re-derives — so
 * it is the one that has to be asserted rather than assumed.
 *
 * Comparison is on the WIRE-relevant projection (`role` + `content`) precisely
 * because `providerOptions` is where the breakpoint itself legitimately moves:
 * every step strips the previous step's marker and adds its own, so including it
 * would assert the opposite of what the sibling test proves.
 */
import type { UIMessage } from "ai";
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startTurn } from "../../src/vendo/loop.js";
import { textTurn, toolCallTurn, type StreamPart } from "../../src/test-doubles.test-util.js";

const echo = tool({
  description: "Echo a value back.",
  inputSchema: z.object({ value: z.string() }),
  execute: async (input: { value: string }) => input,
});

const untouched = tool({
  description: "Never active.",
  inputSchema: z.object({}),
  execute: async () => ({}),
});

const thread = (): UIMessage[] => [
  { id: "m1", role: "user", parts: [{ type: "text", text: "how much did I spend?" }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "Let me look." }] },
  { id: "m3", role: "user", parts: [{ type: "text", text: "keep going" }] },
];

/** What one step actually SENT, captured as strings at call time so nothing the
 *  loop does afterwards can alias its way into the comparison. */
interface SentStep {
  /** The tools block, byte for byte — the part Anthropic renders first. */
  tools: string;
  system: string;
  /** One entry per message, in order: the prefix a later step has to extend. */
  wire: string[];
}

/** Two tool-calling steps then a reply, so the prompt grows twice. */
async function sendSteps(): Promise<SentStep[]> {
  const sent: SentStep[] = [];
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      step += 1;
      sent.push({
        tools: JSON.stringify(request.tools ?? []),
        system: JSON.stringify(request.prompt.filter((message) => message.role === "system")),
        wire: request.prompt.map((message) =>
          JSON.stringify({ role: message.role, content: message.content })),
      });
      const chunks: StreamPart[] = step < 3
        ? toolCallTurn("echo", { value: `v${step}` }, `call_${step}`)
        : textTurn("done");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  const loop = await startTurn({
    model,
    system: "system",
    messages: thread(),
    tools: { echo, untouched },
    activeTools: () => ["echo"],
    context: { maxSteps: 5 },
  });
  for await (const _part of loop.result.fullStream) void _part;
  return sent;
}

describe("the cached prefix is byte-stable across a turn's steps", () => {
  it("sends a byte-identical TOOLS block on every step", async () => {
    // Renders first, so one changed byte here costs the system prompt and the
    // whole history behind it — the most expensive instability available.
    const sent = await sendSteps();
    expect(sent.length).toBe(3);
    for (const [step, call] of sent.entries()) {
      expect(call.tools, `step ${step}`).toBe(sent[0]?.tools);
    }
  });

  it("sends a byte-identical SYSTEM prompt on every step", async () => {
    const sent = await sendSteps();
    for (const [step, call] of sent.entries()) {
      expect(call.system, `step ${step}`).toBe(sent[0]?.system);
    }
  });

  it("only ever APPENDS: each step's prompt extends the previous one verbatim", async () => {
    // The read condition. A step whose prompt merely *contains* the same messages
    // is not enough — a cache hit needs the earlier bytes at the same offsets.
    const sent = await sendSteps();
    for (let step = 1; step < sent.length; step += 1) {
      const previous = sent[step - 1] as SentStep;
      const current = sent[step] as SentStep;
      expect(current.wire.length, `step ${step} grew`).toBeGreaterThan(previous.wire.length);
      expect(current.wire.slice(0, previous.wire.length), `step ${step} prefix`)
        .toEqual(previous.wire);
    }
  });
});
