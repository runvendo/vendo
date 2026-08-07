import { createAnthropic } from "@ai-sdk/anthropic";
import { describe, expect, it } from "vitest";
import { createKnowledgeAnswerJudge, judgeModelId } from "./judge.js";

/**
 * Live judge smoke (e2e doctrine: env-key-gated, out of CI — the
 * packages/guard/test/live/judge.live.test.ts pattern). Runs only when
 * ANTHROPIC_API_KEY is set:
 * `ANTHROPIC_API_KEY=... pnpm --filter @vendoai/corpus-harness test`.
 */
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.runIf(hasKey)("knowledge answer judge live smoke (Anthropic)", () => {
  const judge = () => {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return createKnowledgeAnswerJudge({ model: anthropic(judgeModelId()) });
  };

  it("returns a schema-valid, non-degraded judgement for a grounded answer", { timeout: 120_000 }, async () => {
    const result = await judge()({
      question: "What does vendo doctor check?",
      answer: "Doctor checks local wiring and makes one live /status round trip; exit code 0 means the install is healthy.",
      citations: [{
        docId: "troubleshooting-vendo-doctor-status-and-error",
        snippet: "Doctor checks local wiring and makes one live /status round trip. Exit code 0 means the install is healthy.",
      }],
      keyPoints: ["doctor checks local wiring", "one live /status round trip", "exit code 0 means healthy"],
    });
    expect(result.degraded).toBe(false);
    for (const axis of [result.faithfulness, result.citationCorrectness, result.completeness]) {
      expect(axis.score).toBeGreaterThanOrEqual(1);
      expect(axis.score).toBeLessThanOrEqual(5);
      expect(typeof axis.verdict).toBe("boolean");
    }
    // A fully-grounded answer should judge faithful.
    expect(result.faithfulness.verdict).toBe(true);
  });
});

describe.runIf(!hasKey)("knowledge answer judge live smoke (Anthropic)", () => {
  it.skip("skipped: ANTHROPIC_API_KEY not set", () => {});
});
