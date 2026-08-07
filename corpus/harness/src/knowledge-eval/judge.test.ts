import { describe, expect, it } from "vitest";
import {
  createKnowledgeAnswerJudge,
  DEFAULT_JUDGE_MODEL,
  JUDGE_MODEL_ENV,
  judgeModelId,
  type KnowledgeAnswerInput,
} from "./judge.js";
import { asLanguageModel, scriptedJudgeModel, type JudgeModelScript } from "./scripted-judge-model.test-util.js";

/**
 * T3 — the judge parses, clamps, and degrades like the bench judge: scripted
 * model double covering the happy path, out-of-range scores, garbage output,
 * transport errors (transient retried, hard errors floored), and the
 * env-pinned model id.
 */

const axis = (score: number, verdict: boolean) => ({ score, verdict, note: "n" });

const goodJudgement = {
  faithfulness: axis(5, true),
  citationCorrectness: axis(4, true),
  completeness: axis(3, false),
};

const input: KnowledgeAnswerInput = {
  question: "What is the sky?",
  answer: "The sky is blue.",
  citations: [{ docId: "alpha", snippet: "the sky is blue on clear days" }],
  keyPoints: ["sky", "blue"],
};

function judgeWith(...scripts: JudgeModelScript[]) {
  const model = scriptedJudgeModel(...scripts);
  const judge = createKnowledgeAnswerJudge({
    model: asLanguageModel(model),
    delayMs: () => 0,
  });
  return { model, judge };
}

describe("createKnowledgeAnswerJudge", () => {
  it("parses a schema-valid judgement", async () => {
    const { judge } = judgeWith({ json: goodJudgement });
    const result = await judge(input);
    expect(result.degraded).toBe(false);
    expect(result.faithfulness).toEqual(axis(5, true));
    expect(result.citationCorrectness.score).toBe(4);
    expect(result.completeness.verdict).toBe(false);
  });

  it("clamps wild scores into 1-5 integers", async () => {
    const { judge } = judgeWith({
      json: {
        faithfulness: axis(9, true),
        citationCorrectness: axis(0, false),
        completeness: axis(3.4, true),
      },
    });
    const result = await judge(input);
    expect(result.degraded).toBe(false);
    expect(result.faithfulness.score).toBe(5);
    expect(result.citationCorrectness.score).toBe(1);
    expect(result.completeness.score).toBe(3);
  });

  it("degrades to the floor on persistent garbage output", async () => {
    const { model, judge } = judgeWith({ text: "the judge rambles instead of returning JSON" });
    const result = await judge(input);
    expect(result.degraded).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.faithfulness).toEqual({ score: 1, verdict: false, note: "judge degraded" });
    expect(result.citationCorrectness.verdict).toBe(false);
    expect(result.completeness.score).toBe(1);
    // Garbage is retried (a judge can flake once), then floored.
    expect(model.doGenerateCalls.length).toBe(3);
  });

  it("degrades on a schema-shaped-but-wrong object", async () => {
    const { judge } = judgeWith({ json: { verdict: "yes", quality: "excellent" } });
    const result = await judge(input);
    expect(result.degraded).toBe(true);
  });

  it("retries transient transport errors and succeeds", async () => {
    const { model, judge } = judgeWith(
      { error: new Error("429 rate limited, slow down") },
      { json: goodJudgement },
    );
    const result = await judge(input);
    expect(result.degraded).toBe(false);
    expect(result.faithfulness.score).toBe(5);
    expect(model.doGenerateCalls.length).toBe(2);
  });

  it("treats gateway errors (502/503/504) as transient too", async () => {
    for (const message of ["502 Bad Gateway", "503 Service Unavailable", "504 Gateway Timeout"]) {
      const { model, judge } = judgeWith({ error: new Error(message) }, { json: goodJudgement });
      const result = await judge(input);
      expect(result.degraded, message).toBe(false);
      expect(model.doGenerateCalls.length, message).toBe(2);
    }
  });

  it("floors a persistent hard error with the message preserved", async () => {
    const { judge } = judgeWith({ error: new Error("judge model unavailable") });
    const result = await judge(input);
    expect(result.degraded).toBe(true);
    expect(result.error).toContain("judge model unavailable");
  });
});

describe("judgeModelId", () => {
  it("defaults to the independent stronger tier and honors the env pin", () => {
    expect(judgeModelId({})).toBe(DEFAULT_JUDGE_MODEL);
    expect(judgeModelId({ [JUDGE_MODEL_ENV]: "claude-sonnet-5" })).toBe("claude-sonnet-5");
  });
});
