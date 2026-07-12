import type { LanguageModel } from "ai";

/**
 * Minimal deterministic LanguageModel (spec v2) for measuring engine overhead
 * without an LLM. Mirrors the shape of @vendoai/apps' testing scripted model
 * (which is not exported via a subpath). Each doGenerate returns the next
 * scripted response; the last response repeats.
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
    async doStream() {
      throw new Error("scripted model does not stream");
    },
  };
  return model as unknown as LanguageModel;
};

/** A scripted model that emits a realistic rung-1 tree with data-bound nodes and queries. */
export const appGenerationModel = (): LanguageModel =>
  scriptedLanguageModel(() =>
    JSON.stringify({
      name: "Bench App",
      description: "A scripted app used to measure apps-api overhead.",
      tree: {
        formatVersion: "vendo-genui/v1",
        root: "root",
        nodes: [
          { id: "root", component: "Stack", source: "prewired", children: ["title", "row", "note"] },
          { id: "title", component: "Text", source: "prewired", props: { text: "Items" } },
          { id: "row", component: "Row", source: "prewired", children: ["count", "first"] },
          { id: "count", component: "Text", source: "prewired", props: { text: { $path: "/items/0/name" } } },
          { id: "first", component: "Text", source: "prewired", props: { text: { $state: "selected" } } },
          { id: "note", component: "Text", source: "prewired", props: { text: "ready" } },
        ],
        data: { items: [] },
        queries: [{ path: "/items", tool: "host_items_list", input: {} }],
      },
    }),
  );
