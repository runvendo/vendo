/** A CONTROLLABLE scripted LanguageModel for the browser leg.
 *
 * Same technique as the node harness (fixtures/integration/src/harness.ts) — ONE
 * model instance drives BOTH the agent loop (doStream) and the apps generation
 * engine (doGenerate) off a single FIFO queue — but the queue is MUTABLE so the
 * test (running in a separate process from the model) can enqueue turns over the
 * wire server's `/__test/script` control endpoint before it drives the page.
 *
 * The control endpoint speaks a small high-level TurnSpec dialect (kind:"text" |
 * "tool" | "generate") rather than raw stream parts, so tests stay legible and
 * the JSON on the wire stays tiny; this module expands each spec into the exact
 * LanguageModelV3 stream parts the composed system consumes.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

type LanguageModelV3StreamPart = Awaited<
  ReturnType<MockLanguageModelV3["doStream"]>
>["stream"] extends ReadableStream<infer Part> ? Part : never;
type LanguageModelV3GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
type LanguageModelV3Content = LanguageModelV3GenerateResult["content"][number];

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** A plain assistant text turn (agent doStream). */
function textTurn(text: string, id = "text_1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

/** An agent turn that calls one tool (agent doStream). */
function toolCallTurn(
  toolName: string,
  input: unknown,
  toolCallId = "call_1",
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

/**
 * The high-level control dialect the `/__test/script` endpoint accepts.
 *
 * There was a third kind, `generate`: one turn whose whole text was a CREATE/EDIT
 * dialect document, which the generation pipeline read through `doGenerate`. That
 * pipeline is gone. A create is the screen agent now, and the screen agent WRITES
 * — it calls `save_app` with the document and then speaks. So a create is scripted
 * with the two kinds already here:
 *
 *   { kind: "tool", name: "save_app", input: { content: "<App …>…</App>" } },
 *   { kind: "text", text: "saved" },
 *
 * The kind is deleted rather than left unused on purpose. A scripted model that
 * answers a create with bare dialect text does not fail loudly — the assembly loop
 * consumes the turn, saves nothing, and the ask ends in "assembly produced nothing
 * that renders" one screen later. Five fixtures were written that way before this
 * one; taking the affordance away is what stops a sixth.
 */
export type TurnSpec =
  | { kind: "text"; text: string; id?: string }
  | { kind: "tool"; name: string; input: unknown; toolCallId?: string };

export function expandTurn(spec: TurnSpec): LanguageModelV3StreamPart[] {
  switch (spec.kind) {
    case "text":
      return textTurn(spec.text, spec.id);
    case "tool":
      return toolCallTurn(spec.name, spec.input, spec.toolCallId);
  }
}

export interface ControllableModel {
  model: MockLanguageModelV3;
  /** Append expanded turns to the shared FIFO queue. */
  enqueue(turns: LanguageModelV3StreamPart[][]): void;
  /** Drop every queued turn (between-journey reset). */
  reset(): void;
}

export function createControllableModel(): ControllableModel {
  const queue: LanguageModelV3StreamPart[][] = [];
  const shift = (): LanguageModelV3StreamPart[] => {
    const chunks = queue.shift();
    if (chunks === undefined) throw new Error("scripted model exhausted");
    return chunks;
  };
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: shift() }) }),
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      const chunks = shift();
      const finish = chunks.find((part) => part.type === "finish");
      const content: LanguageModelV3Content[] = [];
      const text = chunks
        .filter((part): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      if (text.length > 0) content.push({ type: "text", text });
      for (const part of chunks) if (part.type === "tool-call") content.push(structuredClone(part));
      return {
        content,
        finishReason: finish?.finishReason ?? { unified: "stop", raw: undefined },
        usage: finish?.usage ?? ZERO_USAGE,
        warnings: [],
      };
    },
  });
  return {
    model,
    enqueue(turns) {
      for (const turn of turns) queue.push([...turn]);
    },
    reset() {
      queue.length = 0;
    },
  };
}
