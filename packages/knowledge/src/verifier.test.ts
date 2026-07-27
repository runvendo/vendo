import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { entailmentVerifier, KNOWLEDGE_VERIFY_TIMEOUT_MS } from "./verifier.js";

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** A model returning `text` verbatim as its one generation, recording the
    prompts it saw (mirrors refine.test.ts's proposalModel). */
function scriptedModel(text: string): LanguageModel & { prompts: string[]; calls: number } {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (request) => {
      const last = request.prompt[request.prompt.length - 1];
      const content = last !== undefined && Array.isArray(last.content) ? last.content : [];
      prompts.push(
        content
          .filter((part): part is { type: "text"; text: string } => (part as { type: string }).type === "text")
          .map((part) => part.text)
          .join(""),
      );
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
  }) as LanguageModel & { prompts: string[]; calls: number };
  Object.defineProperty(model, "prompts", { get: () => prompts });
  Object.defineProperty(model, "calls", { get: () => prompts.length });
  return model;
}

/** A model that never answers — the hang the timeout exists for. */
function hangingModel(): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: () => new Promise(() => {}),
  }) as LanguageModel;
}

const passages = [
  { docId: "install-react", title: "Install in React", snippet: "Mount the overlay with <VendoProvider> inside your React app." },
];

describe("entailmentVerifier (K14 T2)", () => {
  it("returns the model's supported verdict", async () => {
    const supported = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: true, rationale: "states it" })) });
    await expect(supported.supported({ question: "How do I mount in React?", passages })).resolves.toBe(true);

    const refused = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: false, rationale: "Vue is not covered" })) });
    await expect(refused.supported({ question: "How do I mount in Vue?", passages })).resolves.toBe(false);
  });

  it("puts the question, the passages and a drafted answer in the prompt", async () => {
    const model = scriptedModel(JSON.stringify({ supported: true, rationale: "ok" }));
    await entailmentVerifier({ model }).supported({
      question: "How do I mount in React?",
      passages,
      answer: "Use VendoProvider.",
    });
    const prompt = model.prompts.join("\n");
    expect(prompt).toContain("How do I mount in React?");
    expect(prompt).toContain("VendoProvider");
    expect(prompt).toContain("Use VendoProvider.");
    expect(prompt).toContain("install-react");
  });

  it("refuses without spending a model call when there are no passages", async () => {
    const model = scriptedModel(JSON.stringify({ supported: true, rationale: "unreachable" }));
    await expect(entailmentVerifier({ model }).supported({ question: "anything", passages: [] })).resolves.toBe(false);
    expect(model.calls).toBe(0);
  });

  it("gives NO verdict on garbage model output, and warns once per cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verifier = entailmentVerifier({ model: scriptedModel("I think probably yes?") });
      await expect(verifier.supported({ question: "q", passages })).resolves.toBeUndefined();
      await expect(verifier.supported({ question: "q", passages })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("falling back to the score threshold");
    } finally {
      warn.mockRestore();
    }
  });

  it("gives NO verdict when the model hangs past the cap, and returns promptly", async () => {
    const verifier = entailmentVerifier({ model: hangingModel(), timeoutMs: 30 });
    const started = Date.now();
    await expect(verifier.supported({ question: "q", passages })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("caps a verification at four seconds by default", () => {
    expect(KNOWLEDGE_VERIFY_TIMEOUT_MS).toBe(4000);
  });
});
