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
  it("returns the model's verdict WITH the gap it named", async () => {
    const supported = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: true, gap: "states the React mount" })) });
    await expect(supported.verify({ question: "How do I mount in React?", passages })).resolves.toEqual({
      supported: true,
      gap: "states the React mount",
    });

    const refused = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: false, gap: "Vue is not covered" })) });
    await expect(refused.verify({ question: "How do I mount in Vue?", passages })).resolves.toEqual({
      supported: false,
      gap: "Vue is not covered",
    });
  });

  it("puts the question, the passages and a drafted answer in the prompt", async () => {
    const model = scriptedModel(JSON.stringify({ supported: true, gap: "ok" }));
    await entailmentVerifier({ model }).verify({
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
    const model = scriptedModel(JSON.stringify({ supported: true, gap: "unreachable" }));
    await expect(entailmentVerifier({ model }).verify({ question: "anything", passages: [] })).resolves.toMatchObject({
      supported: false,
    });
    expect(model.calls).toBe(0);
  });

  it("gives NO verdict on garbage model output, and warns once per cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verifier = entailmentVerifier({ model: scriptedModel("I think probably yes?") });
      await expect(verifier.verify({ question: "q", passages })).resolves.toBeUndefined();
      await expect(verifier.verify({ question: "q", passages })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("falling back to the score threshold");
    } finally {
      warn.mockRestore();
    }
  });

  it("gives NO verdict when the model hangs past the cap, and returns promptly", async () => {
    const verifier = entailmentVerifier({ model: hangingModel(), timeoutMs: 30 });
    const started = Date.now();
    await expect(verifier.verify({ question: "q", passages })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("gives NO verdict when the model returns an EMPTY or placeholder gap", async () => {
    // A verdict whose gap is torn off is not a verdict: it reaches the refusal
    // and the gap log carrying nothing. Better to fall open marked than to
    // refuse a user with "I don't know — N/A".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const gap of ["", "   ", "N/A", "none", "-"]) {
        const verifier = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: false, gap })) });
        await expect(verifier.verify({ question: "q", passages })).resolves.toBeUndefined();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("gives NO verdict on a BOILERPLATE gap — junk evidence never justifies a refusal", async () => {
    // Round 2 (checker's three probes): all of these cleared the 12-character
    // bar while naming nothing. A refusal must be able to say WHAT is missing;
    // a verdict that cannot is invalid output, and the tool falls open MARKED.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const gap of ["not enough info", "insufficient information", "the answer is unknown"]) {
        const verifier = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: false, gap })) });
        await expect(verifier.verify({ question: "q", passages })).resolves.toBeUndefined();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a SPECIFIC gap that a generic-refusal filter could over-match", async () => {
    // The specificity rule is one content word, not fancy NLP: these read like
    // refusals but each names the thing that is missing, so they must survive.
    for (const gap of [
      "the docs cover React, not Vue",
      "no information about pricing tiers",
      "the passages describe setup, not the APY formula",
    ]) {
      const verifier = entailmentVerifier({ model: scriptedModel(JSON.stringify({ supported: false, gap })) });
      await expect(verifier.verify({ question: "q", passages })).resolves.toEqual({ supported: false, gap });
    }
  });

  it("keeps a real gap, trimmed", async () => {
    const verifier = entailmentVerifier({
      model: scriptedModel(JSON.stringify({ supported: false, gap: "  the passages never mention Vue  " })),
    });
    await expect(verifier.verify({ question: "q", passages })).resolves.toEqual({
      supported: false,
      gap: "the passages never mention Vue",
    });
  });

  it("caps a verification at the measured five seconds by default", () => {
    expect(KNOWLEDGE_VERIFY_TIMEOUT_MS).toBe(5000);
  });

  it("takes the caller's remaining turn budget when it is TIGHTER than the cap", async () => {
    // K15: the second verification of a chat→deep turn runs in what the first
    // left, so a hanging model cannot spend the cap twice on one turn.
    const verifier = entailmentVerifier({ model: hangingModel(), timeoutMs: 10_000 });
    const started = Date.now();
    await expect(verifier.verify({ question: "q", passages }, { timeoutMs: 40 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("never lets the caller's budget RAISE the per-call cap", async () => {
    const verifier = entailmentVerifier({ model: hangingModel(), timeoutMs: 40 });
    const started = Date.now();
    await expect(verifier.verify({ question: "q", passages }, { timeoutMs: 60_000 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
