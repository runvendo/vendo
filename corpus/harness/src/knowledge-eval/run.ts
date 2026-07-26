import type { KnowledgeAdapter, KnowledgeContext, KnowledgeIntent, KnowledgeSearchResult } from "@vendoai/core";
import {
  buildScorecard,
  renderScorecardMarkdown,
  scorecardExitCode,
  writeScorecardArtifacts,
  type ScorecardCheck,
  type ScorecardLayerInput,
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
import type { KnowledgeAnswerJudge } from "./judge.js";

/**
 * The knowledge eval runner (docs/eval/KNOWLEDGE.md): load the fixture corpus
 * into the engine, run the golden items per intent, compute recall@5 + MRR,
 * run the refusal set through the tool-policy predicate, and compare against
 * the engine's ratcheted bars. Deterministic and offline for the memory
 * engine — the model-costed judge leg only runs when a judge is injected
 * (nightly, or scripted in tests), never on the per-PR path.
 */

export const RETRIEVAL_K = 5;

/** The pinned tool policy's weakness threshold (K1 pins: weakness = zero
    hits OR all score < threshold). The memory engine always scores 1, so
    offline refusal mechanics reduce to zero-hits — by design. */
export const WEAK_SCORE_THRESHOLD = 0.35;

export interface RefusalProbe {
  outcome: "answered" | "insufficient-evidence";
  hits: number;
}

function isWeak(result: KnowledgeSearchResult, threshold: number): boolean {
  if (result.hits.length === 0) return true;
  return result.hits.every((hit) => typeof hit.score === "number" && hit.score < threshold);
}

/** The tool-policy refusal predicate: chat by default, exactly ONE deep
    retry on weakness, still weak → insufficient-evidence. */
export async function probeRefusal(
  engine: KnowledgeAdapter,
  question: string,
  ctx: KnowledgeContext,
  threshold = WEAK_SCORE_THRESHOLD,
): Promise<RefusalProbe> {
  const first = await engine.search({ text: question, intent: "chat", limit: RETRIEVAL_K }, ctx);
  if (!isWeak(first, threshold)) return { outcome: "answered", hits: first.hits.length };
  const retry = await engine.search({ text: question, intent: "deep", limit: RETRIEVAL_K }, ctx);
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
  engine: string;
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

function formatMetrics(metrics: Record<string, number>): string {
  const lines = ["", "| Metric | Value |", "| --- | --- |"];
  for (const [key, value] of Object.entries(metrics)) {
    lines.push(`| ${key} | ${value.toFixed(3)} |`);
  }
  return lines.join("\n");
}

export async function runKnowledgeEval(options: KnowledgeEvalOptions, deps: KnowledgeEvalDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => { console.log(line); });
  const stderr = deps.stderr ?? ((line: string) => { console.error(line); });
  const now = deps.now ?? (() => new Date());
  const workspaceRoot = deps.workspaceRoot ?? defaultWorkspaceRoot;
  const createContext = deps.createContext ?? createRunContext;
  const createEngine = deps.createEngine ?? defaultCreateEngine;

  try {
    const [corpus, golden, refusals, bars] = await Promise.all([
      (deps.loadCorpus ?? loadFixtureCorpus)(),
      (deps.loadGolden ?? loadGoldenSet)(workspaceRoot),
      (deps.loadRefusals ?? loadRefusalSet)(workspaceRoot),
      (deps.loadBars ?? loadEngineBars)(options.engine, workspaceRoot),
    ]);

    const engine = createEngine(options.engine);
    if (engine.upsert === undefined) {
      throw new Error(`Engine "${options.engine}" declares no write posture; the eval cannot load the fixture corpus.`);
    }
    await engine.upsert(corpus.docs);

    // --- Layer 1: retrieval ------------------------------------------------
    const outcomes: RetrievalOutcome[] = [];
    const retrievalChecks: ScorecardCheck[] = [];
    for (const item of golden.items) {
      const intent: KnowledgeIntent = item.intent ?? "chat";
      const text = options.engine === "memory" && item.memoryQuery !== undefined ? item.memoryQuery : item.question;
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

    // --- Layer 2: refusals (any non-refusal = hard failure) ----------------
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

    // --- Layer 3: judge (model-costed; injected or loudly skipped) ---------
    let judgeLayer: ScorecardLayerInput;
    if (deps.judgeLeg === undefined) {
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
        const answer = deps.judgeLeg.answers[item.id];
        if (answer === undefined) continue;
        const judgement = await deps.judgeLeg.judge({
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
      const judgeChecks: ScorecardCheck[] = Object.entries(perAxis).map(([axis, data]) => {
        const mean = data.scores.length === 0 ? 0 : data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        metrics[`judge.${axis}`] = Number(mean.toFixed(6));
        const passed = data.verdicts.filter(Boolean).length;
        return {
          id: `judge.${axis}`,
          pass: data.verdicts.length > 0 && passed === data.verdicts.length,
          detail: `mean score ${mean.toFixed(2)}/5; verdicts ${passed}/${data.verdicts.length}${degraded > 0 ? `; ${degraded} degraded judgement(s)` : ""}`,
        };
      });
      judgeLayer = { layer: 3, name: "judge", checks: judgeChecks };
    }

    // --- Layer 4: bars (ratchet floors; skips are loud) ---------------------
    const barsChecks: ScorecardCheck[] = [];
    if (bars === null) {
      barsChecks.push({
        id: "bars.regression",
        pass: true,
        detail: `no bars recorded for engine "${options.engine}"; metrics are not regression-checked (add docs/eval/knowledge/bars/${options.engine}.json)`,
      });
    } else {
      const breaches: string[] = [];
      const unmeasured: string[] = [];
      for (const [key, floor] of Object.entries(bars.bars)) {
        const measured = metrics[key];
        if (measured === undefined) {
          unmeasured.push(key);
        } else if (measured + EPSILON < floor) {
          breaches.push(`${key}: measured ${measured.toFixed(3)} < bar ${floor}`);
        }
      }
      barsChecks.push({
        id: "bars.regression",
        pass: breaches.length === 0,
        detail: breaches.length === 0
          ? `all ${Object.keys(bars.bars).length - unmeasured.length} measured bars met`
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

    const scorecard = buildScorecard({
      generatedAt: now().toISOString(),
      strict: options.strict,
      repos: [
        {
          repo: "knowledge-eval",
          layers: [
            { layer: 1, name: `retrieval (${options.engine})`, checks: retrievalChecks },
            { layer: 2, name: "refusals", checks: refusalChecks },
            judgeLayer,
            { layer: 4, name: "bars", checks: barsChecks },
          ],
        },
      ],
    });

    const context = createContext();
    await writeScorecardArtifacts(scorecard, { context });

    if (options.json) {
      stdout(JSON.stringify({ ...scorecard, metrics }, null, 2));
    } else {
      stdout(renderScorecardMarkdown(scorecard, { linkBaseDir: context.corpusRoot }));
      stdout(formatMetrics(metrics));
    }

    return scorecardExitCode(scorecard);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
