/**
 * The scripted LanguageModel and the stream parts it replays.
 *
 * ONE model instance drives BOTH the agent loop (`doStream`) and the apps
 * generation engine (`doGenerate`) off a single FIFO queue, so a journey scripts
 * turns in the exact order the composed system will consume them.
 *
 * This is a MODEL double, not a seam double: the counterparty it stands in for
 * is Anthropic's API, which a test genuinely cannot call. Everything between the
 * suite and this model — the wire, the loop, the guard, the store — stays real.
 * Nothing that has a real write path and a real read path inside this repo
 * belongs in here.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

export type LanguageModelV3Prompt = Parameters<MockLanguageModelV3["doStream"]>[0]["prompt"];
export type LanguageModelV3StreamPart = Awaited<
  ReturnType<MockLanguageModelV3["doStream"]>
>["stream"] extends ReadableStream<infer Part> ? Part : never;
export type LanguageModelV3GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;
export type LanguageModelV3Content = LanguageModelV3GenerateResult["content"][number];

export const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** A plain assistant text turn (agent doStream). */
export function textTurn(text: string, id = "text_1"): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

/** An agent turn that calls one tool (agent doStream). */
export function toolCallTurn(
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
 * One scripted turn: the chunks, or a function of the prompt that was handed to
 * the model.
 *
 * The function form exists for the ids a journey cannot know in advance — the
 * front door mints an app's id at request time and writes it into the screen
 * agent's brief, so a turn that has to NAME that app (`validate({ appId })`)
 * reads it off the brief exactly as the model it stands in for would.
 */
export type ScriptedTurn =
  | LanguageModelV3StreamPart[]
  | ((prompt: LanguageModelV3Prompt) => LanguageModelV3StreamPart[]);

export type ScriptedModel = MockLanguageModelV3 & { prompts: LanguageModelV3Prompt[] };

export function scriptedModel(turns: readonly ScriptedTurn[]): ScriptedModel {
  const remaining = turns.map((turn) => (typeof turn === "function" ? turn : [...turn]));
  const prompts: LanguageModelV3Prompt[] = [];
  const shift = (prompt: LanguageModelV3Prompt): LanguageModelV3StreamPart[] => {
    prompts.push(structuredClone(prompt));
    const turn = remaining.shift();
    if (turn === undefined) throw new Error("scripted model exhausted");
    const chunks = typeof turn === "function" ? turn(prompt) : turn;
    return chunks;
  };
  const model = new MockLanguageModelV3({
    doStream: async (request) => ({ stream: simulateReadableStream({ chunks: shift(request.prompt) }) }),
    doGenerate: async (request): Promise<LanguageModelV3GenerateResult> => {
      const chunks = shift(request.prompt);
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
  }) as ScriptedModel;
  model.prompts = prompts;
  return model;
}
