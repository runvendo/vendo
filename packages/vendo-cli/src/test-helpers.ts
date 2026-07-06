/**
 * Test-only helpers (imported by *.test.ts, excluded from the build via the
 * tsconfig test exclude — kept in src so vitest resolves relative imports).
 * Mirrors the MockLanguageModelV3 wiring used across the repo
 * (see packages/vendo-runtime/src/policy/natural-language.test.ts).
 */
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

const ZERO_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** A mock model that replies with `responses` in order (last one repeats). */
export function textModel(responses: string[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: responses[Math.min(i++, responses.length - 1)]! }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });
}

export function throwingModel(message: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      throw new Error(message);
    },
  });
}

/**
 * A mock model that records the raw call options it was invoked with, so
 * tests can inspect the prompt actually sent (e.g. assert some source text
 * never reached the LLM). Replies with `reply` on every call.
 */
export function capturingModel(reply: string): { model: MockLanguageModelV3; calls: unknown[] } {
  const calls: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options: unknown): Promise<LanguageModelV3GenerateResult> => {
      calls.push(options);
      return {
        content: [{ type: "text", text: reply }],
        finishReason: { unified: "stop", raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
  });
  return { model, calls };
}
