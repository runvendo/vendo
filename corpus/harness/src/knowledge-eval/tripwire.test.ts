import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunContext } from "../run-context.js";
import { createKnowledgeAnswerJudge } from "./judge.js";
import { runKnowledgeEval } from "./run.js";
import { asLanguageModel, scriptedJudgeModel } from "./scripted-judge-model.test-util.js";

/**
 * T5 — the bad-answer tripwire, the spec's literal done-criterion: the suite
 * must FAIL LOUDLY when seeded with a bad answer. Both tripwires run the
 * real pipeline end to end (real golden set, real memory engine, the real
 * judge module over a scripted model) and assert a nonzero exit.
 */

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function runSeeded(judgement: {
  faithfulness: { score: number; verdict: boolean; note: string };
  citationCorrectness: { score: number; verdict: boolean; note: string };
  completeness: { score: number; verdict: boolean; note: string };
}): Promise<{ exitCode: number; output: string }> {
  const corpusRoot = await mkdtemp(path.join(tmpdir(), "knowledge-tripwire-"));
  tempRoots.push(corpusRoot);
  const lines: string[] = [];

  const judge = createKnowledgeAnswerJudge({
    model: asLanguageModel(scriptedJudgeModel({ json: judgement })),
    delayMs: () => 0,
  });

  const exitCode = await runKnowledgeEval(
    { engines: ["memory"], json: true, strict: true },
    {
      stdout: (line) => { lines.push(line); },
      stderr: (line) => { lines.push(line); },
      createContext: () => createRunContext({ corpusRoot }),
      judgeLeg: {
        judge,
        // One seeded answer is enough to trip the wire: the fabricated claim
        // cites the WRONG document on purpose.
        answers: {
          "gs-welcome": {
            answer: "Vendo is a hosted CRM that stores your customer data in its own cloud.",
            citations: [{ docId: "glossary-venue", snippet: "a venue is where an agent surface runs" }],
          },
        },
      },
    },
  );
  return { exitCode, output: lines.join("\n") };
}

describe("bad-answer tripwire", () => {
  it("a wrong canned judgement (fabricated answer) turns the run red", async () => {
    const { exitCode, output } = await runSeeded({
      faithfulness: { score: 1, verdict: false, note: "claim not entailed by the cited snippet" },
      citationCorrectness: { score: 2, verdict: false, note: "citation does not support the claim" },
      completeness: { score: 1, verdict: false, note: "no key point covered" },
    });
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(output) as {
      summary: { hardFailureCount: number };
      repos: { layers: { name: string; checks: { id: string; pass: boolean }[] }[] }[];
    };
    expect(parsed.summary.hardFailureCount).toBeGreaterThan(0);
    const judgeLayer = parsed.repos[0]?.layers.find((layer) => layer.name === "judge");
    expect(judgeLayer?.checks.find((check) => check.id === "judge.faithfulness")?.pass).toBe(false);
  });

  it("a planted wrong citation trips citation-correctness even when the prose reads well", async () => {
    const { exitCode } = await runSeeded({
      faithfulness: { score: 4, verdict: true, note: "prose is plausible" },
      citationCorrectness: { score: 1, verdict: false, note: "cited doc is about venues, not the product" },
      completeness: { score: 4, verdict: true, note: "covers the points" },
    });
    expect(exitCode).not.toBe(0);
  });

  it("the same run with a good judgement stays green (the wire trips on badness, not on judging)", async () => {
    const { exitCode } = await runSeeded({
      faithfulness: { score: 5, verdict: true, note: "entailed" },
      citationCorrectness: { score: 5, verdict: true, note: "supported" },
      completeness: { score: 5, verdict: true, note: "covered" },
    });
    expect(exitCode).toBe(0);
  });
});
