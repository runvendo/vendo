/**
 * Tests for naturalLanguagePolicy — LLM judge guardrail layer.
 *
 * Uses MockLanguageModelV3 from ai/test (no network). The judge implementation
 * uses generateText (not generateObject) because it is simpler to wire against
 * MockLanguageModelV3: the mock's doGenerate returns plain text content, which
 * the implementation parses to extract the decision token. See natural-language.ts
 * for the rationale comment.
 */

import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { PolicyContext } from "./types";
import { naturalLanguagePolicy } from "./natural-language";

// Minimal usage object required by LanguageModelV3GenerateResult.
const ZERO_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** Build a mock that returns a single text token as its generate result. */
function mockReturning(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });
}

/** Build a mock whose doGenerate always throws. */
function mockThrowing(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      throw new Error("judge model failure");
    },
  });
}

/**
 * Build a mock backed by a spy whose return text can change between calls.
 * `spy` tracks how many times the judge model was actually invoked.
 */
function spyMock(impl: () => string): {
  model: MockLanguageModelV3;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  const model = new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: spy() }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });
  return { model, spy };
}

/** Minimal valid PolicyContext for these tests. */
const fakeCtx: PolicyContext = {
  toolName: "sendEmail",
  input: { to: "alice@example.com", subject: "Hello" },
  descriptor: {
    name: "sendEmail",
    source: "caller",
    annotations: {},
    hasExecute: true,
    kind: "function",
  },
  principal: { userId: "u1" },
};

const rules = [
  "Never allow sending emails to external recipients without approval.",
  "Deny any file deletion operations outright.",
];

describe("naturalLanguagePolicy", () => {
  it('returns "deny" when the judge returns "deny"', async () => {
    const policy = naturalLanguagePolicy(rules, mockReturning("deny"));
    expect(await policy.evaluate(fakeCtx)).toBe("deny");
  });

  it('returns "approve" when the judge returns "approve"', async () => {
    const policy = naturalLanguagePolicy(rules, mockReturning("approve"));
    expect(await policy.evaluate(fakeCtx)).toBe("approve");
  });

  it('returns "allow" when the judge returns "allow"', async () => {
    const policy = naturalLanguagePolicy(rules, mockReturning("allow"));
    expect(await policy.evaluate(fakeCtx)).toBe("allow");
  });

  it('returns "deny" (fail-closed) when the judge model throws', async () => {
    const policy = naturalLanguagePolicy(rules, mockThrowing());
    expect(await policy.evaluate(fakeCtx)).toBe("deny");
  });

  it("memoises a successful decision: two identical (toolName, input) evaluations call the model once", async () => {
    const { model, spy } = spyMock(() => "approve");
    const policy = naturalLanguagePolicy(rules, model);

    expect(await policy.evaluate(fakeCtx)).toBe("approve");
    expect(await policy.evaluate(fakeCtx)).toBe("approve"); // served from memo
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a different (toolName, input) is a cache miss and calls the model again", async () => {
    const { model, spy } = spyMock(() => "allow");
    const policy = naturalLanguagePolicy(rules, model);

    await policy.evaluate(fakeCtx);
    await policy.evaluate({
      ...fakeCtx,
      input: { to: "bob@example.com", subject: "Different" },
    });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a transient judge failure is NOT memoised: a later identical call returns the real decision", async () => {
    let calls = 0;
    const { model, spy } = spyMock(() => {
      calls++;
      if (calls === 1) throw new Error("transient judge failure");
      return "allow";
    });
    const policy = naturalLanguagePolicy(rules, model);

    // First call: judge throws → fail-closed "deny", and NOT cached.
    expect(await policy.evaluate(fakeCtx)).toBe("deny");
    // Second identical call: re-invokes the judge (deny was not memoised) and
    // now returns the real decision.
    expect(await policy.evaluate(fakeCtx)).toBe("allow");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("bounds the judge memo with LRU eviction so it cannot grow without limit", async () => {
    const ctxWith = (id: number): PolicyContext => ({
      ...fakeCtx,
      input: { to: `user${id}@example.com` },
    });
    const { model, spy } = spyMock(() => "allow");
    const policy = naturalLanguagePolicy(rules, model, { maxMemo: 2 });

    await policy.evaluate(ctxWith(1)); // miss → memo [1]
    await policy.evaluate(ctxWith(2)); // miss → memo [1,2]
    await policy.evaluate(ctxWith(1)); // HIT → refresh recency → memo [2,1]
    await policy.evaluate(ctxWith(3)); // miss → evict LRU (2) → memo [1,3]
    expect(spy).toHaveBeenCalledTimes(3);

    // input 1 was recently used, so it survived eviction → cache hit, no new call.
    await policy.evaluate(ctxWith(1));
    expect(spy).toHaveBeenCalledTimes(3);

    // input 2 was the LRU victim → cache miss → the model is consulted again.
    await policy.evaluate(ctxWith(2));
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
