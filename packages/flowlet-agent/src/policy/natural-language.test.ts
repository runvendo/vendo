/**
 * Tests for naturalLanguagePolicy — LLM judge guardrail layer.
 *
 * Uses MockLanguageModelV3 from ai/test (no network). The judge implementation
 * uses generateText (not generateObject) because it is simpler to wire against
 * MockLanguageModelV3: the mock's doGenerate returns plain text content, which
 * the implementation parses to extract the decision token. See natural-language.ts
 * for the rationale comment.
 */

import { describe, it, expect } from "vitest";
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
});
