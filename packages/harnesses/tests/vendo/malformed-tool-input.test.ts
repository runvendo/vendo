/**
 * A tool call the model emitted as broken JSON must not poison the next step.
 *
 * When a model's tool-call input text does not parse — malformed JSON, or a
 * generation truncated at `max_tokens` mid-object — the AI SDK's `parseToolCall`
 * falls back to keeping the RAW STRING as that call's `input`, marks the call
 * invalid, and enqueues a `tool-error` as its output. The step loop then
 * CONTINUES, and `toResponseMessages` writes that string straight into the
 * assistant message it appends to the running prompt. On the next step the stock
 * Anthropic provider serializes it verbatim as `tool_use.input`, and the provider
 * rejects the whole request: `tool_use.input: Input should be an object`. One
 * malformed call therefore kills the entire turn rather than costing it a step.
 *
 * The projection's own well-formedness pass cannot catch this: it runs once, on
 * the step-0 history, and the poisoned message is minted by the SDK mid-turn.
 * `prepareStep` is the only thing that sees EVERY step's prompt, so that is where
 * the shape is enforced.
 *
 * The proof is one question asked of the step that follows the bad call: is every
 * tool-call input in the prompt an object? A string there is a request the
 * provider will 400 on, so the assertion is about the wire shape and nothing else.
 * `{}` is the right repair rather than a lossy one — the paired tool result
 * already tells the model its input was invalid, so it re-issues the call with
 * real arguments.
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

const note = tool({
  description: "Write a note.",
  inputSchema: z.object({ content: z.string() }),
  execute: async (input: { content: string }) => input,
});

/** Exactly what a generation cut off at `max_tokens` mid-object leaves behind. */
const TRUNCATED_INPUT = '{"content": "abc';

const thread = (): UIMessage[] => [
  { id: "m1", role: "user", parts: [{ type: "text", text: "write a note" }] },
];

/** Step 1 emits the unparseable call; step 2 replies, so there IS a next prompt. */
function truncatedCallModel(): MockLanguageModelV3 {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      const chunks: StreamPart[] = step === 1
        ? [
            {
              type: "tool-call" as const,
              toolCallId: "call_1",
              toolName: "note",
              input: TRUNCATED_INPUT,
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

/** Every tool-call part of one step's prompt, whichever message carries it. */
function toolCallInputs(prompt: StepPrompt): unknown[] {
  return prompt.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) => (part.type === "tool-call" ? [part.input] : [])));
}

async function runTurn() {
  const model = truncatedCallModel();
  const loop = await startTurn({
    model,
    system: "system",
    messages: thread(),
    tools: { note },
    context: { maxSteps: 5 },
  });
  for await (const _part of loop.result.fullStream) void _part;
  return model.doStreamCalls;
}

describe("a malformed tool call does not poison the next step's prompt", () => {
  it("sends the failed call's input as an OBJECT, never the raw string", async () => {
    const calls = await runTurn();
    // The turn has to keep going for there to be a poisoned prompt at all.
    expect(calls.length).toBe(2);
    const inputs = toolCallInputs((calls[1] as (typeof calls)[number]).prompt);
    expect(inputs.length).toBe(1);
    for (const input of inputs) {
      expect(typeof input, `raw input was ${JSON.stringify(input)}`).toBe("object");
      expect(input).not.toBeNull();
    }
  });

  it("repairs to an empty object rather than inventing arguments", async () => {
    // Anything non-empty would be arguments the model never asked for; the paired
    // tool result already carries the invalid-input error that prompts a retry.
    const calls = await runTurn();
    expect(toolCallInputs((calls[1] as (typeof calls)[number]).prompt)).toEqual([{}]);
  });

  it("still pairs the failed call with a tool result", async () => {
    // The repair rewrites tool CALLS only. If it touched outputs, or if the call
    // lost its result, the prompt would be malformed in a second, different way.
    const calls = await runTurn();
    const prompt = (calls[1] as (typeof calls)[number]).prompt;
    const results = prompt.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : [])));
    expect(results).toEqual(["call_1"]);
  });
});
