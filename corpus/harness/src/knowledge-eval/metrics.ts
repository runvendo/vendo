/**
 * Retrieval metrics for the knowledge eval (spec §Evals 2): recall@k and MRR
 * against expected doc ids, aggregated overall and per intent. Pure functions
 * over ranked id lists — no engine, no filesystem — so unit tests pin the
 * math exactly.
 */

export interface RetrievalOutcome {
  /** Golden item id, for per-item scorecard checks. */
  itemId: string;
  intent: "chat" | "deep" | "schema";
  expectedDocIds: readonly string[];
  /** Ranked doc ids the engine returned, most relevant first. */
  rankedDocIds: readonly string[];
}

/** |expected ∩ top-k| / |expected|. */
export function recallAtK(expected: readonly string[], ranked: readonly string[], k: number): number {
  if (expected.length === 0) return 1;
  const topK = new Set(ranked.slice(0, k));
  const found = expected.filter((id) => topK.has(id)).length;
  return found / expected.length;
}

/** 1 / rank of the first expected doc; 0 when none is retrieved at all. */
export function reciprocalRank(expected: readonly string[], ranked: readonly string[]): number {
  const expectedSet = new Set(expected);
  const index = ranked.findIndex((id) => expectedSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

/** Metric ids match bars/<engine>.json keys: "recall@5", "mrr", plus
    per-intent variants ("recall@5.chat", ...) for intents that have items. */
export function aggregateRetrievalMetrics(
  outcomes: readonly RetrievalOutcome[],
  k: number,
): Record<string, number> {
  const metrics: Record<string, number> = {
    [`recall@${k}`]: round(mean(outcomes.map((o) => recallAtK(o.expectedDocIds, o.rankedDocIds, k)))),
    mrr: round(mean(outcomes.map((o) => reciprocalRank(o.expectedDocIds, o.rankedDocIds)))),
  };
  for (const intent of ["chat", "deep", "schema"] as const) {
    const subset = outcomes.filter((o) => o.intent === intent);
    if (subset.length === 0) continue;
    metrics[`recall@${k}.${intent}`] = round(mean(subset.map((o) => recallAtK(o.expectedDocIds, o.rankedDocIds, k))));
    metrics[`mrr.${intent}`] = round(mean(subset.map((o) => reciprocalRank(o.expectedDocIds, o.rankedDocIds))));
  }
  return metrics;
}
