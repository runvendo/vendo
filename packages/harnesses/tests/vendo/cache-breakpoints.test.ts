/**
 * The trailing cache breakpoint moves with the turn.
 *
 * `turnModelMessages` marks the history prefix ONCE, before the first step. That
 * mark is right for a turn that takes one step and wrong for every turn that
 * takes more: a step's own tool calls and tool results are appended to the prompt
 * after it, so from step two onward the growing tail sits OUTSIDE the cached
 * prefix and is re-billed in full on every remaining step. A ten-step build turn
 * is where the whole context lives, and it is exactly the turn that paid the most.
 *
 * The fix is one hook, so the proof is one question asked of every step: which
 * messages carry a breakpoint? The answer must always be two — the static system
 * prompt, and the last message of THIS step's prompt — and the second one must
 * have moved since the step before. Anything else is either a prefix that stopped
 * growing or markers piling up (Anthropic allows four, and a run that accumulates
 * them silently loses the oldest).
 */
import type { UIMessage } from "ai";
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startTurn } from "../../src/vendo/loop.js";
import type { StreamPart } from "../../src/test-doubles.test-util.js";

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

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

/**
 * Long enough that `turnModelMessages` marks a message in the MIDDLE of the
 * prompt: that mark is the stale one every later step has to strip, and without
 * it "no stale markers" could pass on a thread that never had a second mark.
 */
const thread = (): UIMessage[] => [
  { id: "m1", role: "user", parts: [{ type: "text", text: "how much did I spend?" }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "Let me look." }] },
  { id: "m3", role: "user", parts: [{ type: "text", text: "keep going" }] },
];

/** Two tool-calling steps then a reply, so the prompt grows twice. */
function threeStepModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      const chunks: StreamPart[] = step < 3
        ? [
            {
              type: "tool-call" as const,
              toolCallId: `call_${step}`,
              toolName: "echo",
              input: JSON.stringify({ value: `v${step}` }),
            },
            { type: "finish" as const, usage: ZERO_USAGE, finishReason: { unified: "tool-calls" as const, raw: undefined } },
          ]
        : [
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: "done" },
            { type: "text-end" as const, id: "t1" },
            { type: "finish" as const, usage: ZERO_USAGE, finishReason: { unified: "stop" as const, raw: undefined } },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

type StepPrompt = MockLanguageModelV3["doStreamCalls"][number]["prompt"];

/** Which messages of one step's prompt carry an Anthropic cache breakpoint. */
function markedIndexes(prompt: StepPrompt): number[] {
  return prompt.flatMap((message, index) => {
    const cacheControl = message.providerOptions?.anthropic?.cacheControl as
      | { type?: unknown }
      | undefined;
    return cacheControl?.type === "ephemeral" ? [index] : [];
  });
}

/** One turn, drained; the recorded per-step calls are the whole assertion surface. */
async function runTurn(activeTools?: () => string[]) {
  const model = threeStepModel();
  const loop = await startTurn({
    model,
    system: "system",
    messages: thread(),
    tools: { echo, untouched },
    context: { maxSteps: 5 },
    ...(activeTools === undefined ? {} : { activeTools }),
  });
  for await (const _part of loop.result.fullStream) void _part;
  return model.doStreamCalls;
}

const stepPrompts = async (): Promise<StepPrompt[]> =>
  (await runTurn()).map((call) => call.prompt);

describe("the cache breakpoint advances every step", () => {
  it("marks the LAST message of every step's prompt", async () => {
    const prompts = await stepPrompts();
    expect(prompts.length).toBe(3);
    prompts.forEach((prompt, step) => {
      const moving = markedIndexes(prompt).filter((index) => prompt[index]?.role !== "system");
      expect(moving, `step ${step}`).toEqual([prompt.length - 1]);
    });
  });

  it("accumulates no stale markers — exactly the system one plus the moving one", async () => {
    // `turnModelMessages` marked a middle message before the first step, and each
    // step's own tail is appended to that same prompt. Without a strip, step 3
    // would carry the system mark, that stale middle one, and the new tail one.
    const prompts = await stepPrompts();
    prompts.forEach((prompt, step) => {
      expect(markedIndexes(prompt).length, `step ${step}`).toBe(2);
    });
  });

  it("keeps the system marker exactly where it was", async () => {
    const prompts = await stepPrompts();
    prompts.forEach((prompt, step) => {
      expect(prompt[0]?.role, `step ${step}`).toBe("system");
      expect(markedIndexes(prompt)[0], `step ${step}`).toBe(0);
    });
  });

  it("ADVANCES: the moving marker sits further along on every later step", async () => {
    // The point of the whole slice. A marker that stays put is a prefix that
    // stopped growing, which is the bug this replaces.
    const prompts = await stepPrompts();
    const moving = prompts.map((prompt) =>
      markedIndexes(prompt).filter((index) => prompt[index]?.role !== "system")[0]);
    expect(moving.length).toBe(3);
    for (let step = 1; step < moving.length; step += 1) {
      expect(moving[step], `step ${step} vs ${step - 1}`).toBeGreaterThan(moving[step - 1] as number);
    }
  });

  it("still carries the caller's activeTools loadout on the same hook", async () => {
    // `prepareStep` used to exist ONLY under a tool-search session. It is returned
    // on every turn now, and the loadout rides the same result — so a run that
    // gates the model's choice must still gate it.
    const calls = await runTurn(() => ["echo"]);
    expect(calls.length).toBe(3);
    for (const [step, call] of calls.entries()) {
      expect((call.tools ?? []).map((entry) => entry.name), `step ${step}`).toEqual(["echo"]);
      // …and the marker rail did not stop working because the loadout rail joined it.
      expect(markedIndexes(call.prompt).length, `step ${step}`).toBe(2);
    }
  });
});
