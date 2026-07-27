/**
 * Knowledge K14 — the verification band.
 *
 * A single evidence bar decides "is there enough here to answer?" by comparing
 * one engine-relative score to one number. On an engine whose answerable and
 * unanswerable questions score in the SAME range, that comparison cannot be
 * right: the cloud calibration (docs/eval/knowledge/bands/agentset.json) found
 * 16 of 34 unanswerable questions clearing the shipped bar while 7 of 60
 * answerable ones fell below it, and no bar does better — the populations
 * overlap across almost their whole width.
 *
 * The band is where the bar is useless. Below it, only unanswerable questions
 * were ever observed; above it, only answerable ones. Between them the score
 * carries no signal, and that is the only place worth spending a model call.
 * So: below → refuse as today, above → answer as today, inside → the verifier
 * adjudicates (verifier.ts). Bounding the spend to the band is the whole
 * reason the band exists.
 */

/** Observed top scores from a calibration run, one array per population. */
export interface KnowledgeScorePopulations {
  /** Top score of each question the corpus CAN answer. */
  answerable: number[];
  /** Top score of each question the corpus CANNOT answer. */
  unanswerable: number[];
}

/** The score interval where the verifier adjudicates, inclusive at both ends. */
export interface KnowledgeVerifyBand {
  low: number;
  high: number;
}

/** Band edges are quoted to four decimals, matching the shipped bars, and
    rounded OUTWARD — low down, high up. Rounding outward can only widen the
    band, which costs a model call it may not have needed; rounding inward
    would hand a question to the threshold in exactly the region the
    calibration says the threshold is unreliable. */
const PRECISION = 10_000;
const floor4 = (value: number): number => Math.floor(value * PRECISION) / PRECISION;
const ceil4 = (value: number): number => Math.ceil(value * PRECISION) / PRECISION;

/**
 * Derive the band from a calibration run's two populations.
 *
 * The rule: `low = min(answerable)`, `high = max(unanswerable)` — the exact
 * region where the two populations overlap. It is deliberately the widest
 * defensible band rather than a tuned one, because every question it excludes
 * is a question decided by a number the same data says cannot decide it.
 *
 * Two ways there is no band, both returning undefined rather than a degenerate
 * one:
 * - either population is empty (nothing to derive from);
 * - `max(unanswerable) <= min(answerable)` — the populations SEPARATE, so a
 *   plain threshold between them is right on every observed question and a
 *   verifier would only add cost. An engine like that keeps today's path.
 */
export function deriveVerifyBand(populations: KnowledgeScorePopulations): KnowledgeVerifyBand | undefined {
  const { answerable, unanswerable } = populations;
  if (answerable.length === 0 || unanswerable.length === 0) return undefined;
  const low = Math.min(...answerable);
  const high = Math.max(...unanswerable);
  if (high <= low) return undefined;
  return { low: floor4(low), high: ceil4(high) };
}

/** Whether a search's top score lands inside the band (inclusive). */
export function inVerifyBand(topScore: number, band: KnowledgeVerifyBand): boolean {
  return topScore >= band.low && topScore <= band.high;
}
