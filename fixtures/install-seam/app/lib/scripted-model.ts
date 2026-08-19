/**
 * The one double in this app, and the one a test genuinely cannot avoid:
 * Anthropic's API. Everything between the caller and this model — the tool
 * pack, the guard, the actions runtime, /api/todos — stays real.
 *
 * This is the repo's own scripted-model dialect (fixtures/test-kit's
 * `stream-turns.ts`, and the `TurnSpec` wire form
 * fixtures/integration-browser pushes over HTTP), ported here because a
 * stranger installs published packages: it cannot import a private workspace
 * fixture, and `@vendoai/apps/testing` pulls `vitest` into the module graph,
 * which a running server cannot load. `ai/test` is the published primitive
 * underneath all three, so that is what this uses.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

type StreamPart = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer Part>
  ? Part
  : never;

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** One of the model's moves, as it travels in a request body. */
export type TurnSpec =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown };

function expand(turn: TurnSpec, index: number): StreamPart[] {
  if (turn.kind === "tool") {
    return [
      { type: "tool-call", toolCallId: `call_${index + 1}`, toolName: turn.name, input: JSON.stringify(turn.input) },
      { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
    ];
  }
  const id = `text_${index + 1}`;
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: turn.text },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

export function scriptedModel(script: readonly TurnSpec[]): MockLanguageModelV3 {
  const remaining = script.map(expand);
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}
