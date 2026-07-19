import type { LanguageModel } from "ai";

/**
 * Minimal deterministic LanguageModel (spec v2) for measuring engine overhead
 * without an LLM. Mirrors the shape of @vendoai/apps' testing scripted model
 * (which is not exported via a subpath). Each generation or stream call
 * returns the next scripted response; the last response repeats.
 */
type ScriptedCall = {
  prompt: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
};

const textOf = (call: ScriptedCall): string =>
  call.prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join(""),
    )
    .join("\n");

export const scriptedLanguageModel = (
  ...responses: Array<string | ((prompt: string) => string)>
): LanguageModel => {
  let calls = 0;
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-bench-scripted",
    modelId: "vendo-bench-scripted-v1",
    supportedUrls: {},
    async doGenerate(call: ScriptedCall) {
      const response = responses[Math.min(calls, responses.length - 1)];
      if (response === undefined) throw new Error("scripted model has no response");
      const text = typeof response === "function" ? response(textOf(call)) : response;
      calls += 1;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(call: ScriptedCall) {
      const response = responses[Math.min(calls, responses.length - 1)];
      if (response === undefined) throw new Error("scripted model has no response");
      const text = typeof response === "function" ? response(textOf(call)) : response;
      calls += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: text });
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

/** A scripted model that emits a realistic rung-1 wire with data-bound nodes and queries. */
export const appGenerationModel = (): LanguageModel =>
  scriptedLanguageModel(() => [
    '<App name="Bench App">',
    '<Query id="items" tool="host_items_list" input={{}}/>',
    '<Text text="Items"/>',
    '<Row><Text text={items.name}/><Text text={state.selected}/></Row>',
    '<Text text="ready"/>',
    "</App>",
  ].join(""));
