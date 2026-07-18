import type { LanguageModel } from "ai";

export interface ScriptedModelCall {
  prompt: Array<{
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  }>;
}

type ScriptedText = string | string[];

export type ScriptedModelResponse = ScriptedText | ((
  call: ScriptedModelCall,
  index: number,
) => ScriptedText | Promise<ScriptedText>);

const responseText = (
  response: ScriptedModelResponse,
  call: ScriptedModelCall,
  index: number,
): ScriptedText | Promise<ScriptedText> => typeof response === "function" ? response(call, index) : response;

/** Deterministic LanguageModelV2 equivalent for AI SDK generateText e2e tests. */
export const scriptedLanguageModel = (...responses: ScriptedModelResponse[]): LanguageModel => {
  let calls = 0;
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-scripted",
    modelId: "vendo-scripted-v1",
    supportedUrls: {},
    async doGenerate(call: ScriptedModelCall) {
      const response = responses[Math.min(calls, responses.length - 1)];
      if (response === undefined) throw new Error("Scripted language model has no response");
      const value = await responseText(response, call, calls);
      const text = Array.isArray(value) ? value.join("") : value;
      calls += 1;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(call: ScriptedModelCall) {
      const response = responses[Math.min(calls, responses.length - 1)];
      if (response === undefined) throw new Error("Scripted language model has no response");
      const value = await responseText(response, call, calls);
      const chunks = Array.isArray(value) ? value : [value];
      calls += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            for (const delta of chunks) controller.enqueue({ type: "text-delta", id: "text_1", delta });
            controller.enqueue({ type: "text-end", id: "text_1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return model as unknown as LanguageModel;
};

const textOf = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const markedValue = (text: string, marker: string): string => {
  const start = text.lastIndexOf(marker);
  if (start === -1) return "Untitled app";
  const value = text.slice(start + marker.length).split("\n")[0]?.trim() ?? "";
  return value.slice(0, 60) || "Untitled app";
};

/** Compatibility fixture for lifecycle/execution suites that only need valid generation. */
export const basicLanguageModel = (): LanguageModel => scriptedLanguageModel((call) => {
  const prompt = textOf(call);
  if (prompt.includes("TASK: EDIT_TREE")) {
    const instruction = markedValue(prompt, "INSTRUCTION: ");
    return JSON.stringify({ ops: [{ op: "set-name", name: instruction }] });
  }
  const name = markedValue(prompt, "USER_REQUEST: ");
  // v2 spec §2 — creates are wire markup; quotes in the derived name would
  // break the attribute, so strip them.
  return `<App name="${name.replaceAll('"', "'")}"><Text text="${name.replaceAll('"', "'")}"/></App>`;
});
