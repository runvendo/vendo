import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KnowledgeAdapter, KnowledgeDoc, KnowledgeQuery, KnowledgeSearchResult } from "@vendoai/core";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { createRunContext } from "../run-context.js";
import type { EngineBars, FixtureCorpus, GoldenSet, RefusalSet } from "./data.js";
import { EVAL_CONTEXT } from "./engines.js";
import { probeRefusal, runKnowledgeEval, type KnowledgeEvalDeps } from "./run.js";

/**
 * T2/T3 — the runner: retrieval metrics against a tiny corpus with known
 * ranks, the memory engine over the REAL golden set (must be green, strict
 * and not), refusal hard-fails (a planted answerable item turns the run
 * red), bars regression + loud skip, and judge dimensions in the scorecard.
 */

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempContextFactory() {
  const corpusRoot = await mkdtemp(path.join(tmpdir(), "knowledge-eval-"));
  tempRoots.push(corpusRoot);
  return { corpusRoot, createContext: () => createRunContext({ corpusRoot }) };
}

function collector() {
  const lines: string[] = [];
  return { lines, write: (line: string) => { lines.push(line); } };
}

const doc = (id: string, text: string, overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({
  id,
  kind: "docs",
  visibility: "public",
  title: id,
  text,
  source: `test:${id}`,
  ...overrides,
});

/** Five docs; queries are authored so ranks are known (the memory engine
    returns matches in insertion order). */
const tinyCorpus: FixtureCorpus = {
  version: 1,
  docs: [
    doc("alpha", "the sky is blue on clear days"),
    doc("beta", "widget assembly happens in the widget factory"),
    doc("gamma", "widget assembly is inspected twice"),
    doc("delta", "unrelated content about databases"),
    doc("epsilon", "the moon orbits the earth monthly"),
  ],
};

const tinyGolden: GoldenSet = {
  version: 1,
  items: [
    // Unique match at rank 1: recall 1, rr 1.
    { id: "t-sky", question: "the sky is blue", expectedDocIds: ["alpha"], keyPoints: ["sky", "blue"] },
    // Matches beta then gamma; expecting gamma → rank 2: recall 1, rr 0.5.
    { id: "t-widget", question: "widget assembly", expectedDocIds: ["gamma"], keyPoints: ["inspected", "twice"] },
    // No match at all: recall 0, rr 0.
    { id: "t-miss", question: "quantum entanglement", expectedDocIds: ["epsilon"], keyPoints: ["moon", "orbit"] },
  ],
};

const tinyRefusals: RefusalSet = {
  version: 1,
  items: [{ id: "t-refuse", question: "completely absent topic", paraphrases: ["another absent phrasing"] }],
};

type JsonRun = {
  exitCode: number;
  scorecard: {
    summary: { hardFailureCount: number };
    repos: { repo: string; layers: { name: string; status: string; checks: { id: string; pass: boolean; detail: string }[] }[] }[];
    metrics: Record<string, Record<string, number>>;
  };
};

async function runJson(
  overrides: Partial<KnowledgeEvalDeps>,
  options: { strict?: boolean; engines?: string[] } = {},
): Promise<JsonRun> {
  const { createContext } = await tempContextFactory();
  const out = collector();
  const err = collector();
  const exitCode = await runKnowledgeEval(
    { engines: options.engines ?? ["memory"], json: true, strict: options.strict ?? true },
    {
      stdout: out.write,
      stderr: err.write,
      createContext,
      loadCorpus: async () => tinyCorpus,
      loadGolden: async () => tinyGolden,
      loadRefusals: async () => tinyRefusals,
      loadBars: async () => null,
      ...overrides,
    },
  );
  if (out.lines.length === 0) throw new Error(`no JSON output; stderr: ${err.lines.join("\n")}`);
  return { exitCode, scorecard: JSON.parse(out.lines.join("\n")) as JsonRun["scorecard"] };
}

function layer(run: JsonRun, name: string) {
  const found = run.scorecard.repos[0]?.layers.find((entry) => entry.name.startsWith(name));
  if (!found) throw new Error(`no layer "${name}"`);
  return found;
}

describe("runKnowledgeEval retrieval metrics", () => {
  it("computes recall@5 and MRR with known ranks on the tiny corpus", async () => {
    const run = await runJson({});
    const metrics = run.scorecard.metrics["memory"]!;
    expect(metrics["recall@5"]).toBeCloseTo(2 / 3, 6);
    expect(metrics.mrr).toBeCloseTo(0.5, 6);
    expect(metrics["recall@5.chat"]).toBeCloseTo(2 / 3, 6);

    const retrieval = layer(run, "retrieval");
    expect(retrieval.checks.find((check) => check.id === "retrieval.t-sky")?.pass).toBe(true);
    expect(retrieval.checks.find((check) => check.id === "retrieval.t-widget")?.pass).toBe(true);
    expect(retrieval.checks.find((check) => check.id === "retrieval.t-miss")?.pass).toBe(false);
    // Per-item misses are diagnostics (the layer shows FAIL) but the strict
    // gate for retrieval quality is the bars layer — with no bars recorded,
    // this run exits 0. The bars tests below prove the red path.
    expect(retrieval.status).toBe("fail");
    expect(run.exitCode).toBe(0);
    expect(run.scorecard.summary.hardFailureCount).toBe(0);
  });
});

describe("runKnowledgeEval over the real golden set (memory engine)", () => {
  it("exits 0 non-strict AND strict, and writes the scorecard artifact", async () => {
    for (const strict of [false, true]) {
      const { corpusRoot, createContext } = await tempContextFactory();
      const out = collector();
      const err = collector();
      const exitCode = await runKnowledgeEval(
        { engines: ["memory"], json: false, strict },
        { stdout: out.write, stderr: err.write, createContext },
      );
      expect(exitCode, `strict=${strict}: ${err.lines.join("\n")}`).toBe(0);

      const artifact = await readFile(path.join(corpusRoot, ".repos", ".logs", "scorecard.json"), "utf8");
      const scorecard = JSON.parse(artifact) as { summary: { hardFailureCount: number } };
      expect(scorecard.summary.hardFailureCount).toBe(0);
      expect(out.lines.join("\n")).toContain("recall@5");
    }
  }, 60_000);
});

describe("refusal hard-fails", () => {
  it("a planted answerable refusal item turns the run red", async () => {
    const planted: RefusalSet = {
      version: 1,
      items: [
        { id: "t-refuse", question: "completely absent topic", paraphrases: [] },
        // "widget assembly" HAS answers in the tiny corpus → non-refusal.
        { id: "t-planted", question: "widget assembly", paraphrases: [] },
      ],
    };
    const run = await runJson({ loadRefusals: async () => planted });
    const refusals = layer(run, "refusals");
    expect(refusals.checks.find((check) => check.id === "refusal.t-refuse")?.pass).toBe(true);
    const plantedCheck = refusals.checks.find((check) => check.id === "refusal.t-planted");
    expect(plantedCheck?.pass).toBe(false);
    expect(plantedCheck?.detail).toContain("non-refusal outcome");
    expect(run.exitCode).toBe(1);
    expect(run.scorecard.summary.hardFailureCount).toBeGreaterThan(0);
  });

  it("probeRefusal treats all-below-threshold scores as weak and retries deep exactly once", async () => {
    const queries: KnowledgeQuery[] = [];
    const weakEngine: KnowledgeAdapter = {
      posture: { fetch: false, write: false, visibility: "public-only" },
      async search(query): Promise<KnowledgeSearchResult> {
        queries.push(query);
        return {
          hits: [{
            ref: { docId: "alpha" },
            snippet: "weak",
            kind: "docs",
            visibility: "public",
            score: 0.01,
          }],
        };
      },
      async status() {
        return { docs: 1 };
      },
    };
    // Explicit nonzero threshold: the score-based weakness path.
    const probe = await probeRefusal(weakEngine, "anything", EVAL_CONTEXT, 0.35);
    expect(probe.outcome).toBe("insufficient-evidence");
    expect(queries.map((query) => query.intent)).toEqual(["chat", "deep"]);
  });

  it("the default threshold mirrors the shipped tool policy: hits with any score are an answer", async () => {
    const weakScores: KnowledgeAdapter = {
      posture: { fetch: false, write: false, visibility: "public-only" },
      async search(): Promise<KnowledgeSearchResult> {
        return {
          hits: [{
            ref: { docId: "alpha" },
            snippet: "weak but present",
            kind: "docs",
            visibility: "public",
            score: 0.01,
          }],
        };
      },
      async status() {
        return { docs: 1 };
      },
    };
    const probe = await probeRefusal(weakScores, "anything", EVAL_CONTEXT);
    expect(probe.outcome).toBe("answered");
  });

  it("internal fixture docs never answer: the context leaves includeInternal unset", async () => {
    const withInternal: FixtureCorpus = {
      version: 1,
      docs: [...tinyCorpus.docs, doc("secret", "internal only content", { visibility: "internal" })],
    };
    const refusals: RefusalSet = {
      version: 1,
      items: [{ id: "t-internal", question: "internal only content", paraphrases: [] }],
    };
    const run = await runJson({ loadCorpus: async () => withInternal, loadRefusals: async () => refusals });
    expect(layer(run, "refusals").checks.find((check) => check.id === "refusal.t-internal")?.pass).toBe(true);
  });
});

describe("bars", () => {
  const bars = (values: Record<string, number>): EngineBars => ({
    version: 1,
    generatedAt: "2026-07-25T00:00:00.000Z",
    toleranceRationale: "test bars",
    bars: values,
  });

  it("a measured value below its bar is a hard failure under strict", async () => {
    const run = await runJson({
      loadGolden: async () => ({ version: 1, items: [tinyGolden.items[0]!] }),
      loadBars: async () => bars({ mrr: 1, "recall@5": 2 }),
    });
    const check = layer(run, "bars").checks.find((entry) => entry.id === "bars.regression");
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("recall@5");
    expect(run.exitCode).toBe(1);
  });

  it("an unsupported (misspelled) bar key is rejected, never skipped", async () => {
    const run = await runJson({
      loadGolden: async () => ({ version: 1, items: [tinyGolden.items[0]!] }),
      loadBars: async () => bars({ "recal@5": 1, mrr: 1 }),
    });
    const barsLayer = layer(run, "bars");
    const unknownCheck = barsLayer.checks.find((entry) => entry.id === "bars.unknown");
    expect(unknownCheck?.pass).toBe(false);
    expect(unknownCheck?.detail).toContain("recal@5");
    expect(barsLayer.checks.find((entry) => entry.id === "bars.skipped")).toBeUndefined();
    expect(run.exitCode).toBe(1);
  });

  it("bars the run did not measure are skipped LOUDLY, never silently", async () => {
    const run = await runJson({
      loadGolden: async () => ({ version: 1, items: [tinyGolden.items[0]!] }),
      loadBars: async () => bars({ mrr: 1, "judge.faithfulness": 4 }),
    });
    const barsLayer = layer(run, "bars");
    expect(barsLayer.checks.find((entry) => entry.id === "bars.regression")?.pass).toBe(true);
    const skipped = barsLayer.checks.find((entry) => entry.id === "bars.skipped");
    expect(skipped?.pass).toBe(true);
    expect(skipped?.detail).toContain("judge.faithfulness");
    expect(run.exitCode).toBe(0);
  });
});

describe("judge leg", () => {
  it("is loudly skipped offline and its dimensions appear in the scorecard when injected", async () => {
    const offline = await runJson({
      loadGolden: async () => ({ version: 1, items: [tinyGolden.items[0]!] }),
    });
    expect(layer(offline, "judge").status).toBe("skip");

    const judged = await runJson({
      loadGolden: async () => ({ version: 1, items: [tinyGolden.items[0]!, tinyGolden.items[1]!] }),
      judgeLeg: {
        judge: async () => ({
          faithfulness: { score: 5, verdict: true, note: "grounded" },
          citationCorrectness: { score: 4, verdict: true, note: "supported" },
          completeness: { score: 3, verdict: false, note: "one key point missing" },
          degraded: false,
        }),
        answers: {
          "t-sky": { answer: "The sky is blue.", citations: [{ docId: "alpha", snippet: "the sky is blue" }] },
          "t-widget": { answer: "Assembly is inspected twice.", citations: [{ docId: "gamma", snippet: "inspected twice" }] },
        },
      },
    });
    const judgeLayer = layer(judged, "judge");
    expect(judgeLayer.checks.find((check) => check.id === "judge.coverage")?.pass).toBe(true);
    expect(judgeLayer.checks.find((check) => check.id === "judge.faithfulness")?.pass).toBe(true);
    expect(judgeLayer.checks.find((check) => check.id === "judge.completeness")?.pass).toBe(false);
    const metrics = judged.scorecard.metrics["memory"]!;
    expect(metrics["judge.faithfulness"]).toBe(5);
    expect(metrics["judge.citationCorrectness"]).toBe(4);
    expect(metrics["judge.completeness"]).toBe(3);
  });

  it("a golden item missing from the answers map FAILS coverage instead of inflating results", async () => {
    const run = await runJson({
      loadGolden: async () => ({ version: 1, items: [tinyGolden.items[0]!, tinyGolden.items[1]!] }),
      judgeLeg: {
        judge: async () => ({
          faithfulness: { score: 5, verdict: true, note: "grounded" },
          citationCorrectness: { score: 5, verdict: true, note: "supported" },
          completeness: { score: 5, verdict: true, note: "covered" },
          degraded: false,
        }),
        // t-widget deliberately absent.
        answers: {
          "t-sky": { answer: "The sky is blue.", citations: [{ docId: "alpha", snippet: "the sky is blue" }] },
        },
      },
    });
    const coverage = layer(run, "judge").checks.find((check) => check.id === "judge.coverage");
    expect(coverage?.pass).toBe(false);
    expect(coverage?.detail).toContain("t-widget");
    expect(run.exitCode).toBe(1);
    expect(run.scorecard.summary.hardFailureCount).toBeGreaterThan(0);
  });
});

describe("per-engine comparison", () => {
  it("multiple engines produce one scorecard section and one metrics column each", async () => {
    const run = await runJson(
      {
        // A second engine that never finds anything: its metrics column must
        // diverge from memory's while sharing the same golden set.
        createEngine: (name) =>
          name === "empty"
            ? {
                posture: { fetch: false, write: true, visibility: "public-only" },
                async search(): Promise<KnowledgeSearchResult> {
                  return { hits: [] };
                },
                async upsert() {},
                async status() {
                  return { docs: 0 };
                },
              }
            : memoryKnowledgeAdapter(),
      },
      { engines: ["memory", "empty"], strict: false },
    );
    expect(run.scorecard.repos.map((repo) => repo.repo)).toEqual(["knowledge-memory", "knowledge-empty"]);
    expect(run.scorecard.metrics["memory"]?.["recall@5"]).toBeCloseTo(2 / 3, 6);
    expect(run.scorecard.metrics["empty"]?.["recall@5"]).toBe(0);
    // Non-strict comparison runs report and exit 0 even with failures.
    expect(run.exitCode).toBe(0);
  });
});

describe("engine registry", () => {
  it("an unknown engine fails fast with the known list", async () => {
    const { createContext } = await tempContextFactory();
    const err = collector();
    const exitCode = await runKnowledgeEval(
      { engines: ["nope"], json: false, strict: false },
      { stderr: err.write, stdout: () => {}, createContext },
    );
    expect(exitCode).toBe(1);
    expect(err.lines.join("\n")).toContain('Unknown knowledge engine "nope"');
    expect(err.lines.join("\n")).toContain("memory");
  });

  it("the lexical registry engine is writable and searchable offline", async () => {
    const { createEngine } = await import("./engines.js");
    const engine = createEngine("lexical");
    expect(engine.upsert).toBeDefined();
    await engine.upsert!([doc("lex-doc", "the quarterly report ships in october")]);
    const result = await engine.search({ text: "quarterly report", limit: 5 }, EVAL_CONTEXT);
    expect(result.hits.map((hit) => hit.ref.docId)).toContain("lex-doc");
  });

  it("the memory registry engine enforces the public-only default", async () => {
    const engine = memoryKnowledgeAdapter({
      docs: [doc("secret", "hidden text", { visibility: "internal" })],
    });
    const result = await engine.search({ text: "hidden text" }, EVAL_CONTEXT);
    expect(result.hits).toEqual([]);
  });
});
