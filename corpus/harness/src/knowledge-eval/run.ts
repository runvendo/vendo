import type { KnowledgeAdapter, KnowledgeContext, KnowledgeIntent, KnowledgeSearchResult } from "@vendoai/core";
import {
  buildScorecard,
  renderScorecardMarkdown,
  scorecardExitCode,
  writeScorecardArtifacts,
  type ScorecardCheck,
  type ScorecardLayerInput,
  type ScorecardRepoInput,
} from "../scorecard.js";
import { createRunContext, type CorpusRunContext } from "../run-context.js";
import {
  defaultWorkspaceRoot,
  loadEngineBars,
  loadFixtureCorpus,
  loadGoldenSet,
  loadRefusalSet,
  type EngineBars,
  type FixtureCorpus,
  type GoldenSet,
  type RefusalSet,
} from "./data.js";
import { createEngine as defaultCreateEngine, EVAL_CONTEXT } from "./engines.js";
import { aggregateRetrievalMetrics, recallAtK, reciprocalRank, type RetrievalOutcome } from "./metrics.js";
import { KNOWLEDGE_JUDGE_AXES, type KnowledgeAnswerJudge } from "./judge.js";

/**
 * The knowledge eval runner (docs/eval/KNOWLEDGE.md): load the fixture corpus
 * into each selected engine, run the golden items per intent, compute
 * recall@5 + MRR, run the refusal set through the tool-policy predicate, and
 * compare against each engine's ratcheted bars. Multiple `--engine` flags
 * produce the per-engine comparison (spec §Evals 6): one scorecard section
 * per engine plus a metrics table with engine columns (the ai/matrix.ts
 * scoreboard shape, engines instead of models). Deterministic and offline
 * for the memory engine — the model-costed judge leg only runs when a judge
 * is injected (nightly, or scripted in tests), never on the per-PR path.
 */

export const RETRIEVAL_K = 5;

/** The pinned tool policy's weakness threshold (K1 pins: weakness = zero
    hits OR all score < threshold). Mirrors createKnowledgeTools' SHIPPED
    default (weakScoreThreshold: 0 — score-based weakness disabled, zero
    hits is the only weakness signal), so the eval measures the real
    product policy. Scores are engine-relative (knowledge.ts), so any
    nonzero default here would silently diverge per engine. */
export const WEAK_SCORE_THRESHOLD = 0;

export interface RefusalProbe {
  outcome: "answered" | "insufficient-evidence";
  hits: number;
}

function isWeak(result: KnowledgeSearchResult, threshold: number): boolean {
  if (result.hits.length === 0) return true;
  if (threshold <= 0) return false;
  return result.hits.every((hit) => typeof hit.score === "number" && hit.score < threshold);
}

/** The tool-policy refusal predicate: chat by default, exactly ONE deep
    retry on weakness, still weak → insufficient-evidence. Mirrors the
    shipped tool's search calls exactly — createKnowledgeTools passes NO
    `limit` (the engine default), so this probe must not either: a limit
    could only shrink the hit list and manufacture refusals the real tool
    would never produce. */
export async function probeRefusal(
  engine: KnowledgeAdapter,
  question: string,
  ctx: KnowledgeContext,
  threshold = WEAK_SCORE_THRESHOLD,
): Promise<RefusalProbe> {
  const first = await engine.search({ text: question, intent: "chat" }, ctx);
  if (!isWeak(first, threshold)) return { outcome: "answered", hits: first.hits.length };
  const retry = await engine.search({ text: question, intent: "deep" }, ctx);
  if (!isWeak(retry, threshold)) return { outcome: "answered", hits: retry.hits.length };
  return { outcome: "insufficient-evidence", hits: retry.hits.length };
}

/** The judge leg's inputs: answers are produced elsewhere (canned in tests,
    a real agent nightly) — the runner only judges and aggregates. */
export interface JudgeLeg {
  judge: KnowledgeAnswerJudge;
  answers: Record<string, { answer: string; citations: { docId: string; snippet: string }[] }>;
}

export interface KnowledgeEvalOptions {
  /** Engines to run and compare; every engine gets its own scorecard section
      and metrics column. */
  engines: string[];
  json: boolean;
  strict: boolean;
}

export interface KnowledgeEvalDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
  workspaceRoot?: string;
  createContext?: () => CorpusRunContext;
  createEngine?: (name: string) => KnowledgeAdapter;
  loadGolden?: (workspaceRoot: string) => Promise<GoldenSet>;
  loadRefusals?: (workspaceRoot: string) => Promise<RefusalSet>;
  loadBars?: (engine: string, workspaceRoot: string) => Promise<EngineBars | null>;
  loadCorpus?: () => Promise<FixtureCorpus>;
  /** Absent = the offline carve-out: the judge layer records a loud skip. */
  judgeLeg?: JudgeLeg;
}

const EPSILON = 1e-9;

/** Every metric id the runner can ever emit. Bars files may only use these:
    a misspelled key would otherwise sit unmeasured forever and pass as
    "skipped", silently gating nothing. */
export const SUPPORTED_BAR_KEYS: ReadonlySet<string> = new Set([
  `recall@${RETRIEVAL_K}`,
  "mrr",
  ...(["chat", "deep", "schema"] as const).flatMap((intent) => [`recall@${RETRIEVAL_K}.${intent}`, `mrr.${intent}`]),
  ...KNOWLEDGE_JUDGE_AXES.map((axis) => `judge.${axis}`),
]);

/** Engine columns, metric rows — the per-engine comparison table. */
export function formatMetricsComparison(metricsByEngine: Record<string, Record<string, number>>): string {
  const engines = Object.keys(metricsByEngine);
  const metricKeys = [...new Set(engines.flatMap((engine) => Object.keys(metricsByEngine[engine] ?? {})))];
  const lines = [
    "",
    `| Metric | ${engines.join(" | ")} |`,
    `| --- | ${engines.map(() => "---").join(" | ")} |`,
  ];
  for (const key of metricKeys) {
    const cells = engines.map((engine) => {
      const value = metricsByEngine[engine]?.[key];
      return value === undefined ? "—" : value.toFixed(3);
    });
    lines.push(`| ${key} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

interface EngineRunInput {
  engineName: string;
  corpus: FixtureCorpus;
  golden: GoldenSet;
  refusals: RefusalSet;
  bars: EngineBars | null;
  createEngine: (name: string) => KnowledgeAdapter;
  judgeLeg: JudgeLeg | undefined;
}

interface EngineRunResult {
  repo: ScorecardRepoInput;
  metrics: Record<string, number>;
}

async function runEngine(input: EngineRunInput): Promise<EngineRunResult> {
  const { engineName, corpus, golden, refusals, bars } = input;
  const engine = input.createEngine(engineName);
  if (engine.upsert === undefined) {
    throw new Error(`Engine "${engineName}" declares no write posture; the eval cannot load the fixture corpus.`);
  }
  await engine.upsert(corpus.docs);

  // --- Layer 1: retrieval --------------------------------------------------
  const outcomes: RetrievalOutcome[] = [];
  const retrievalChecks: ScorecardCheck[] = [];
  for (const item of golden.items) {
    const intent: KnowledgeIntent = item.intent ?? "chat";
    const text = engineName === "memory" && item.memoryQuery !== undefined ? item.memoryQuery : item.question;
    const result = await engine.search(
      { text, intent, ...(item.kinds === undefined ? {} : { kinds: item.kinds }), limit: RETRIEVAL_K },
      EVAL_CONTEXT,
    );
    const rankedDocIds = result.hits.map((hit) => hit.ref.docId);
    outcomes.push({ itemId: item.id, intent, expectedDocIds: item.expectedDocIds, rankedDocIds });
    const recall = recallAtK(item.expectedDocIds, rankedDocIds, RETRIEVAL_K);
    const rr = reciprocalRank(item.expectedDocIds, rankedDocIds);
    retrievalChecks.push({
      id: `retrieval.${item.id}`,
      pass: recall === 1,
      detail: `recall@${RETRIEVAL_K}=${recall.toFixed(2)} rr=${rr.toFixed(2)} hits=[${rankedDocIds.join(", ")}]`,
    });
  }
  const metrics = aggregateRetrievalMetrics(outcomes, RETRIEVAL_K);

  // --- Layer 2: refusals (any non-refusal = hard failure) -------------------
  const refusalChecks: ScorecardCheck[] = [];
  for (const item of refusals.items) {
    const answered: string[] = [];
    for (const phrasing of [item.question, ...item.paraphrases]) {
      const probe = await probeRefusal(engine, phrasing, EVAL_CONTEXT);
      if (probe.outcome !== "insufficient-evidence") answered.push(`"${phrasing}" (${probe.hits} hits)`);
    }
    refusalChecks.push({
      id: `refusal.${item.id}`,
      pass: answered.length === 0,
      detail: answered.length === 0
        ? "refused on every phrasing"
        : `non-refusal outcome on: ${answered.join("; ")}`,
    });
  }

  // --- Layer 3: judge (model-costed; injected or loudly skipped) ------------
  let judgeLayer: ScorecardLayerInput;
  if (input.judgeLeg === undefined) {
    judgeLayer = {
      layer: 3,
      name: "judge",
      status: "skip",
      detail: "offline run: the model-costed judge leg runs nightly or with an injected judge (docs/eval/KNOWLEDGE.md carve-out)",
      hardFailure: false,
    };
  } else {
    const perAxis: Record<string, { scores: number[]; verdicts: boolean[] }> = {
      faithfulness: { scores: [], verdicts: [] },
      citationCorrectness: { scores: [], verdicts: [] },
      completeness: { scores: [], verdicts: [] },
    };
    let degraded = 0;
    for (const item of golden.items) {
      const answer = input.judgeLeg.answers[item.id];
      if (answer === undefined) continue;
      const judgement = await input.judgeLeg.judge({
        question: item.question,
        answer: answer.answer,
        citations: answer.citations,
        keyPoints: item.keyPoints,
      });
      if (judgement.degraded) degraded += 1;
      for (const axis of ["faithfulness", "citationCorrectness", "completeness"] as const) {
        perAxis[axis]!.scores.push(judgement[axis].score);
        perAxis[axis]!.verdicts.push(judgement[axis].verdict);
      }
    }
    // Coverage first: a golden item silently missing from the answers map
    // would shrink the denominator and inflate every axis. Missing answers
    // are a failing check (a hard failure under strict), never a skip.
    const missingAnswers = golden.items
      .filter((item) => input.judgeLeg!.answers[item.id] === undefined)
      .map((item) => item.id);
    const listed = missingAnswers.slice(0, 12).join(", ");
    const judgeChecks: ScorecardCheck[] = [{
      id: "judge.coverage",
      pass: missingAnswers.length === 0,
      detail: missingAnswers.length === 0
        ? `answers provided for all ${golden.items.length} golden items`
        : `${missingAnswers.length} golden item(s) have no answer entry: ${listed}${missingAnswers.length > 12 ? ", …" : ""}`,
    }];
    judgeChecks.push(...Object.entries(perAxis).map(([axis, data]) => {
      const mean = data.scores.length === 0 ? 0 : data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
      metrics[`judge.${axis}`] = Number(mean.toFixed(6));
      const passed = data.verdicts.filter(Boolean).length;
      return {
        id: `judge.${axis}`,
        pass: data.verdicts.length > 0 && passed === data.verdicts.length,
        detail: `mean score ${mean.toFixed(2)}/5; verdicts ${passed}/${data.verdicts.length}${degraded > 0 ? `; ${degraded} degraded judgement(s)` : ""}`,
      };
    }));
    judgeLayer = { layer: 3, name: "judge", checks: judgeChecks };
  }

  // --- Layer 4: bars (ratchet floors; skips are loud) ------------------------
  const barsChecks: ScorecardCheck[] = [];
  if (bars === null) {
    barsChecks.push({
      id: "bars.regression",
      pass: true,
      detail: `no bars recorded for engine "${engineName}"; metrics are not regression-checked (add docs/eval/knowledge/bars/${engineName}.json)`,
    });
  } else {
    const breaches: string[] = [];
    const unmeasured: string[] = [];
    const unknown: string[] = [];
    for (const [key, floor] of Object.entries(bars.bars)) {
      if (!SUPPORTED_BAR_KEYS.has(key)) {
        unknown.push(key);
        continue;
      }
      const measured = metrics[key];
      if (measured === undefined) {
        unmeasured.push(key);
      } else if (measured + EPSILON < floor) {
        breaches.push(`${key}: measured ${measured.toFixed(3)} < bar ${floor}`);
      }
    }
    // A key the runner can never emit is a misspelling, not a skip: it would
    // otherwise gate nothing forever while looking configured.
    if (unknown.length > 0) {
      barsChecks.push({
        id: "bars.unknown",
        pass: false,
        detail: `bars file uses unsupported metric key(s): ${unknown.join(", ")} — supported: ${[...SUPPORTED_BAR_KEYS].join(", ")}`,
      });
    }
    barsChecks.push({
      id: "bars.regression",
      pass: breaches.length === 0,
      detail: breaches.length === 0
        ? `all ${Object.keys(bars.bars).length - unmeasured.length - unknown.length} measured bars met`
        : breaches.join("; "),
    });
    if (unmeasured.length > 0) {
      barsChecks.push({
        id: "bars.skipped",
        pass: true,
        detail: `bars not measured by this run (model-costed legs): ${unmeasured.join(", ")}`,
      });
    }
  }

  return {
    repo: {
      repo: `knowledge-${engineName}`,
      layers: [
        {
          layer: 1,
          name: `retrieval (${engineName})`,
          checks: retrievalChecks,
          // Per-item misses are diagnostics, not the gate: real engines are
          // lossy by nature and their regression gate is the calibrated bars
          // layer (spec §Evals 2 — recall/MRR against STORED pass bars).
          // Refusals and judge verdicts stay hard below.
          hardFailure: false,
        },
        { layer: 2, name: "refusals", checks: refusalChecks },
        judgeLayer,
        { layer: 4, name: "bars", checks: barsChecks },
      ],
    },
    metrics,
  };
}

export async function runKnowledgeEval(options: KnowledgeEvalOptions, deps: KnowledgeEvalDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => { console.log(line); });
  const stderr = deps.stderr ?? ((line: string) => { console.error(line); });
  const now = deps.now ?? (() => new Date());
  const workspaceRoot = deps.workspaceRoot ?? defaultWorkspaceRoot;
  const createContext = deps.createContext ?? createRunContext;
  const createEngine = deps.createEngine ?? defaultCreateEngine;

  try {
    if (options.engines.length === 0) throw new Error("knowledge-eval needs at least one engine");
    const [corpus, golden, refusals] = await Promise.all([
      (deps.loadCorpus ?? loadFixtureCorpus)(),
      (deps.loadGolden ?? loadGoldenSet)(workspaceRoot),
      (deps.loadRefusals ?? loadRefusalSet)(workspaceRoot),
    ]);

    const repos: ScorecardRepoInput[] = [];
    const metricsByEngine: Record<string, Record<string, number>> = {};
    for (const engineName of options.engines) {
      const bars = await (deps.loadBars ?? loadEngineBars)(engineName, workspaceRoot);
      const result = await runEngine({
        engineName,
        corpus,
        golden,
        refusals,
        bars,
        createEngine,
        judgeLeg: deps.judgeLeg,
      });
      repos.push(result.repo);
      metricsByEngine[engineName] = result.metrics;
    }

    const scorecard = buildScorecard({
      generatedAt: now().toISOString(),
      strict: options.strict,
      repos,
    });

    const context = createContext();
    await writeScorecardArtifacts(scorecard, { context });

    if (options.json) {
      stdout(JSON.stringify({ ...scorecard, metrics: metricsByEngine }, null, 2));
    } else {
      stdout(renderScorecardMarkdown(scorecard, { linkBaseDir: context.corpusRoot }));
      stdout(formatMetricsComparison(metricsByEngine));
    }

    return scorecardExitCode(scorecard);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
