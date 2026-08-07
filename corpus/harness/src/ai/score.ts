import { z } from "zod";
import {
  VENDO_JUDGMENTS_FORMAT,
  applyJudgment,
  judgmentFieldsSchema,
  type ExtractedTool,
} from "@vendoai/actions";
import type { ScorecardCheck, ScorecardScore } from "../scorecard.js";
import { aiExpectedToolIdentity, type AiExpectedTool, type RepoAiExpectations } from "./expectations.js";

/**
 * Deterministic scoring for one JUDGMENT PASS over one corpus repo. Pure
 * functions over canned inputs — no model calls, no filesystem — so CI unit
 * tests cover every rubric branch. The matrix runner feeds it the real
 * `.vendo/tools.json` entries plus the `.vendo/judgments.json` the pass wrote.
 *
 * The one join that matters: a tool's EFFECTIVE state is `tools.json` entry ⊕ its
 * applied judgment, computed by `applyJudgment` itself rather than re-implemented
 * here, so the corpus inherits the two rules that are easiest to get wrong by
 * hand — a judgment whose binding moved is INERT, and `pending` loosenings are
 * never merged.
 *
 * That is the state the CHANNEL decided — the same state `vendo doctor`
 * displays, and the same one the runtime resolves once the layer's
 * applier is in the tree (`effectiveHostTool` in
 * `packages/actions/src/runtime/registry.ts`, which composes
 * `mergeOverride(applyJudgment(extracted, judgment), override)`).
 *
 * NOTE for whoever sequences the judgment stack: that applier arrives in its own
 * lane, and this branch does not contain it, so on THIS tree a judgment reaches
 * doctor and try but not the running catalog. Nothing here depends on the
 * difference — the rubric scores the channel's decision, which is the thing under
 * test — but the corpus cannot be read as evidence that the runtime enforces
 * what it grades until the applier lands with it.
 *
 * Dimensions:
 * - pass — did the judgment pass produce a judgments file at all (hard failure);
 * - evidence — every APPLIED judgment carries a non-blank quote. A grade with no
 *   evidence is an opinion, and the whole channel exists to refuse those, so the
 *   corpus verifies the property from OUTSIDE rather than trusting the writer's
 *   own schema;
 * - descriptions — quality proxies over judged prose: coverage, non-mechanical,
 *   length bounds, mentions of the bound resource;
 * - risk — accuracy against `ai-expected.json`, scored in BOTH directions. A
 *   hardening applies itself; a downgrade is a loosening that only lands once a
 *   human accepts it, so a repo that never earns its downgrades now scores lower
 *   instead of being excused by an informational check;
 * - confirmEach — the confirmEach marks the labels ask for;
 * - wake — the wake decision for statically-unclassifiable (disabled) tools.
 */

export type AiRiskLabel = "read" | "write" | "destructive";

/** One entry of `.vendo/tools.json`, whole, plus its identity in the
 * expectations key format (`GET\t/api/x`, `trpc\tx.y`, …). The full tool is
 * kept because `applyJudgment` needs a real `ExtractedTool` — a reduction
 * would silently skip the binding check and the fail-closed audience rule. */
export interface AiScoredStaticTool {
  tool: ExtractedTool;
  identity: string;
}

/**
 * One `.vendo/judgments.json` entry as READ BACK, deliberately more lenient than
 * `toolJudgmentSchema`: `evidence` is optional here. The real schema requires it,
 * which is exactly why the acceptance lane must not reuse that schema — parsing
 * with it would turn "the channel wrote an evidenceless judgment" into a crash
 * instead of the scored failure `ai.evidence.present` is there to report.
 */
export const aiScoredJudgmentSchema = z.object({
  binding: z.string().min(1),
  srcHash: z.string().min(1).optional(),
  fields: judgmentFieldsSchema,
  evidence: z.string().optional(),
  // Spelled out rather than derived from `pendingLooseningSchema` for the same
  // reason `evidence` is optional above: the acceptance lane must READ what the
  // channel actually wrote, including entries the strict schema would reject.
  pending: z.array(z.object({
    field: z.enum(["risk", "confirmEach", "disabled", "audience"]),
    value: z.union([z.string(), z.boolean()]),
    evidence: z.string().optional(),
    reason: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export type AiScoredJudgment = z.infer<typeof aiScoredJudgmentSchema>;

/** The file wrapper. `format` stays STRICT: a wrong format is a channel bug the
 *  matrix should surface as a failed cell, not read past. `tools` entries are
 *  lenient per `aiScoredJudgmentSchema`. */
export const aiScoredJudgmentsFileSchema = z.object({
  format: z.literal(VENDO_JUDGMENTS_FORMAT),
  tools: z.record(aiScoredJudgmentSchema),
}).passthrough();

export interface ScoreAiJudgmentsInput {
  staticTools: readonly AiScoredStaticTool[];
  /** null = the pass produced no judgments file to grade. */
  judgments: Readonly<Record<string, AiScoredJudgment>> | null;
  passError?: string;
  expected: RepoAiExpectations | null;
}

export interface AiJudgmentScore {
  score: ScorecardScore;
  checks: ScorecardCheck[];
  /** Sub-scores grouped by rubric dimension (pass, evidence, descriptions, risk,
   * confirmEach, wake) for the scoreboard columns. */
  dimensions: Record<string, ScorecardScore>;
  hardFailure: boolean;
}

const RISK_ORDER: Record<AiRiskLabel, number> = { read: 0, write: 1, destructive: 2 };
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 200;
const GENERIC_TOKENS = new Set([
  "api", "the", "and", "for", "with", "get", "post", "put", "patch", "delete",
  "new", "all", "app", "route", "routes", "index", "internal",
]);

interface WeightedCheck {
  check: ScorecardCheck;
  /** Points earned on a 0..weight scale. */
  points: number;
  weight: number;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

/** x-of-y as points on one check; an empty denominator earns full credit
 * (nothing to judge), matching the layer-2 precision/recall convention. */
function fraction(matched: number, total: number): number {
  return total === 0 ? 1 : matched / total;
}

function weighted(id: string, matched: number, total: number, detail: string): WeightedCheck {
  const value = fraction(matched, total);
  return { check: { id, pass: value === 1, detail }, points: value, weight: 1 };
}

/** Resource words a good description should echo, derived from the binding
 * identity (path segments, procedure/operation parts, export names). */
export function resourceTokens(identity: string): string[] {
  const [kind, rest] = identity.split("\t");
  if (kind === undefined || rest === undefined) return [];
  const raw = rest
    .split(/[/.#_-]/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((part) => part.toLowerCase().trim());
  const tokens = raw.filter((token) =>
    token.length >= 3
    && !GENERIC_TOKENS.has(token)
    && !/[{}[\]:]/.test(token)
    && !/^v\d+$/.test(token));
  return [...new Set(tokens)];
}

function mentionsResource(description: string, tokens: readonly string[]): boolean {
  const haystack = description.toLowerCase();
  return tokens.some((token) => {
    const singular = token.replace(/es$/, "").replace(/s$/, "");
    return haystack.includes(token) || (singular.length >= 3 && haystack.includes(singular));
  });
}

function normalizeDescription(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isMechanicalDescription(description: string, staticDescription: string | undefined): boolean {
  const normalized = normalizeDescription(description);
  if (normalized === normalizeDescription(staticDescription)) return true;
  if (/^(get|post|put|patch|delete|head|options)\s+\/\S*$/.test(normalized)) return true;
  return /^route\s+\S+\s+could not be classified$/.test(normalized);
}

const listed = (names: readonly string[], limit = 6): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;

interface ExpectedJoin {
  label: AiExpectedTool;
  entry: AiScoredStaticTool;
}

/** Labels joined to static tools by binding identity. Labels with no extracted
 * counterpart are a static-extraction recall problem (layer 2's job), surfaced
 * in details but never scored against the judgment pass. */
function joinExpected(
  expected: RepoAiExpectations | null,
  staticTools: readonly AiScoredStaticTool[],
): { joined: ExpectedJoin[]; unmatched: AiExpectedTool[] } {
  if (expected === null) return { joined: [], unmatched: [] };
  const byIdentity = new Map(staticTools.map((entry) => [entry.identity, entry]));
  const joined: ExpectedJoin[] = [];
  const unmatched: AiExpectedTool[] = [];
  for (const label of expected.tools) {
    const entry = byIdentity.get(aiExpectedToolIdentity(label));
    if (entry === undefined) unmatched.push(label);
    else joined.push({ label, entry });
  }
  return { joined, unmatched };
}

export function scoreAiJudgments(input: ScoreAiJudgmentsInput): AiJudgmentScore {
  const { staticTools, judgments, expected } = input;
  const { joined, unmatched } = joinExpected(expected, staticTools);
  const unmatchedNote = unmatched.length > 0
    ? `; ${unmatched.length} labels had no extracted tool (static recall, not scored here)`
    : "";

  const judgmentFor = (name: string): AiScoredJudgment | undefined => judgments?.[name];

  /** The state the runtime will see. `applyJudgment` owns the binding check and
   *  the fail-closed audience rule. Two fields are dropped on the way in:
   *  `pending` because a queued loosening is never merged at runtime, and a
   *  missing `evidence` because presence is scored separately rather than being
   *  allowed to block the merge. */
  const effectiveOf = (entry: AiScoredStaticTool): ExtractedTool => {
    const judgment = judgmentFor(entry.tool.name);
    if (judgment === undefined) return entry.tool;
    const { pending: _neverMerged, ...applied } = judgment;
    return applyJudgment(entry.tool, { ...applied, evidence: applied.evidence ?? "" });
  };

  // A wake is read off the APPLIED field, per the channel's own semantics: it is
  // a loosening, so `fields.disabled === false` can only be there because a human
  // accepted it. Reading the effective tool instead would conflate a refused wake
  // with one that `applyJudgment` re-disabled for a non-end-user audience.
  const wokenBy = (entry: AiScoredStaticTool): boolean =>
    judgmentFor(entry.tool.name)?.fields.disabled === false;

  // Cross-model comparability of score.total rests on two invariants: every check
  // carries a constant weight regardless of its internal fraction, and the
  // no-judgments branch pushes the SAME check set under the same conditions as the
  // scored branch. The sets below are judgment-independent so those conditions
  // never diverge between branches.
  const describable = staticTools.filter((entry) => entry.tool.disabled !== true);
  const confirmEachLabels = joined.filter(({ label }) => label.confirmEach === true);
  const wakeLabels = joined.filter(({ entry }) => entry.tool.disabled === true);

  const checks: WeightedCheck[] = [];

  if (judgments === null) {
    // Same check ids and weights as a scored run, all at zero points: a pass that
    // wrote no judgments floors the whole scoreboard row.
    checks.push({
      check: {
        id: "ai.pass.judged",
        pass: false,
        detail: `the judgment pass produced no judgments file: ${input.passError ?? "unknown error"}`,
      },
      points: 0,
      weight: 1,
    });
    const zero = (id: string): WeightedCheck => ({
      check: { id, pass: false, detail: "no judgments to grade" },
      points: 0,
      weight: 1,
    });
    checks.push(zero("ai.evidence.present"));
    checks.push(zero("ai.descriptions.coverage"));
    checks.push(zero("ai.descriptions.non-mechanical"));
    checks.push(zero("ai.descriptions.length"));
    checks.push(zero("ai.descriptions.mentions-resource"));
    if (expected !== null && joined.length > 0) checks.push(zero("ai.risk.accuracy"));
    if (confirmEachLabels.length > 0) checks.push(zero("ai.confirmEach.applied"));
    if (wakeLabels.length > 0) checks.push(zero("ai.wake.correct"));
    return finalize(checks, true);
  }

  const entries = Object.entries(judgments);
  checks.push({
    check: {
      id: "ai.pass.judged",
      pass: true,
      detail: `the judgment pass wrote ${entries.length} judgment${entries.length === 1 ? "" : "s"} over ${staticTools.length} extracted tools`,
    },
    points: 1,
    weight: 1,
  });

  // ------------------------------------------------------------------
  // Evidence. Scored over judgments that actually APPLY something: an entry with
  // no fields is a bare confirmation ("I read this, nothing to change"), which
  // makes no graded claim for a quote to support.
  // ------------------------------------------------------------------
  const applied = entries.filter(([, judgment]) => Object.keys(judgment.fields).length > 0);
  const confirmations = entries.length - applied.length;
  const evidenceless = applied
    .filter(([, judgment]) => (judgment.evidence ?? "").trim() === "")
    .map(([name]) => name);
  checks.push(weighted(
    "ai.evidence.present",
    applied.length - evidenceless.length,
    applied.length,
    [
      `${applied.length - evidenceless.length}/${applied.length} applied judgments carry evidence`,
      ...(evidenceless.length > 0 ? [`no evidence: ${listed(evidenceless)}`] : []),
      ...(confirmations > 0
        ? [`${confirmations} bare confirmation${confirmations === 1 ? "" : "s"} (no graded field, nothing to evidence)`]
        : []),
    ].join("; "),
  ));

  // ------------------------------------------------------------------
  // Description quality proxies over judged prose that names a real tool.
  // ------------------------------------------------------------------
  const judgedProse = staticTools
    .map((entry) => ({ entry, description: judgmentFor(entry.tool.name)?.fields.description }))
    .filter((pair): pair is { entry: AiScoredStaticTool; description: string } => pair.description !== undefined);
  const describedNames = new Set(judgedProse.map(({ entry }) => entry.tool.name));
  const covered = describable.filter((entry) => describedNames.has(entry.tool.name)).length;
  checks.push(weighted(
    "ai.descriptions.coverage",
    covered,
    describable.length,
    `${covered}/${describable.length} enabled tools received a judged description`,
  ));

  const nonMechanical = judgedProse
    .filter(({ entry, description }) => !isMechanicalDescription(description, entry.tool.description)).length;
  checks.push(weighted(
    "ai.descriptions.non-mechanical",
    nonMechanical,
    judgedProse.length,
    `${nonMechanical}/${judgedProse.length} judged descriptions differ from the path-derived defaults`,
  ));

  const inBounds = judgedProse.filter(({ description }) => {
    const length = description.trim().length;
    return length >= DESCRIPTION_MIN && length <= DESCRIPTION_MAX;
  }).length;
  checks.push(weighted(
    "ai.descriptions.length",
    inBounds,
    judgedProse.length,
    `${inBounds}/${judgedProse.length} judged descriptions are within ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars`,
  ));

  const judgeableMentions = judgedProse.filter(({ entry }) => resourceTokens(entry.identity).length > 0);
  const mentions = judgeableMentions
    .filter(({ entry, description }) => mentionsResource(description, resourceTokens(entry.identity))).length;
  checks.push(weighted(
    "ai.descriptions.mentions-resource",
    mentions,
    judgeableMentions.length,
    `${mentions}/${judgeableMentions.length} judged descriptions mention the bound resource`,
  ));

  // ------------------------------------------------------------------
  // Label-driven dimensions.
  // ------------------------------------------------------------------
  if (expected !== null && joined.length > 0) {
    // An asleep tool has no meaningful risk grade until something wakes it; the
    // wake dimension owns that case instead.
    const judgeable = joined.filter(({ entry }) => entry.tool.disabled !== true || wokenBy(entry));

    /** Which way the label asks the STATIC grade to move. This is the whole point
     *  of the dimension: a hardening applies itself, a downgrade has to survive
     *  the skeptic AND a human, and those are very different odds. A tool
     *  extraction left `ungraded` has no grade to move — the label is the first
     *  one, and it lands directly (risk-grading redesign D2). */
    const direction = ({ label, entry }: ExpectedJoin): "gradings" | "hardenings" | "downgrades" | "already-correct" => {
      if (entry.tool.risk === "ungraded") return "gradings";
      const from = RISK_ORDER[entry.tool.risk];
      const to = RISK_ORDER[label.risk];
      if (to > from) return "hardenings";
      if (to < from) return "downgrades";
      return "already-correct";
    };

    const tally: Record<string, { matched: number; total: number }> = {
      gradings: { matched: 0, total: 0 },
      hardenings: { matched: 0, total: 0 },
      downgrades: { matched: 0, total: 0 },
      "already-correct": { matched: 0, total: 0 },
    };
    const missed: string[] = [];
    for (const join of judgeable) {
      const bucket = tally[direction(join)]!;
      bucket.total += 1;
      const landed = effectiveOf(join.entry).risk;
      if (landed === join.label.risk) bucket.matched += 1;
      else missed.push(`${join.entry.tool.name} (${landed} ≠ ${join.label.risk})`);
    }
    const matched = Object.values(tally).reduce((sum, bucket) => sum + bucket.matched, 0);
    const split = Object.entries(tally)
      .filter(([, bucket]) => bucket.total > 0)
      .map(([name, bucket]) => `${name} ${bucket.matched}/${bucket.total}`)
      .join(", ");
    checks.push(weighted(
      "ai.risk.accuracy",
      matched,
      judgeable.length,
      [
        `${matched}/${judgeable.length} labeled tools ended at the expected risk grade`,
        ...(split === "" ? [] : [`(${split})`]),
        ...(missed.length > 0 ? [`wrong: ${listed(missed)}`] : []),
      ].join(" ") + unmatchedNote,
    ));
  }

  if (confirmEachLabels.length > 0) {
    const wrong = confirmEachLabels
      .filter(({ entry }) => effectiveOf(entry).confirmEach !== true)
      .map(({ entry }) => entry.tool.name);
    checks.push(weighted(
      "ai.confirmEach.applied",
      confirmEachLabels.length - wrong.length,
      confirmEachLabels.length,
      `${confirmEachLabels.length - wrong.length}/${confirmEachLabels.length} expected confirmEach marks were applied`
        + (wrong.length > 0 ? `; missing: ${listed(wrong)}` : ""),
    ));
  }

  if (wakeLabels.length > 0) {
    const wrong: string[] = [];
    for (const { label, entry } of wakeLabels) {
      const woken = wokenBy(entry);
      const correct = label.wake === false
        ? !woken
        : woken && effectiveOf(entry).risk === label.risk;
      if (!correct) {
        wrong.push(`${entry.tool.name} (${label.wake === false ? "must stay asleep" : `expected woken as ${label.risk}`})`);
      }
    }
    checks.push(weighted(
      "ai.wake.correct",
      wakeLabels.length - wrong.length,
      wakeLabels.length,
      wrong.length === 0
        ? `${wakeLabels.length}/${wakeLabels.length} unclassifiable tools got the labeled wake decision`
        : `${wakeLabels.length - wrong.length}/${wakeLabels.length} wake decisions matched the labels; wrong: ${listed(wrong)}`,
    ));
  }

  return finalize(checks, false);
}

function toScore(entries: readonly WeightedCheck[]): ScorecardScore {
  const points = entries.reduce((sum, entry) => sum + entry.points, 0);
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    passed: round(points),
    total,
    value: total === 0 ? 0 : round(points / total),
  };
}

function dimensionOf(checkId: string): string {
  return checkId.split(".")[1] ?? "other";
}

function finalize(weightedChecks: readonly WeightedCheck[], hardFailure: boolean): AiJudgmentScore {
  const scored = weightedChecks.filter((entry) => entry.weight > 0);
  const dimensions: Record<string, ScorecardScore> = {};
  for (const dimension of new Set(scored.map((entry) => dimensionOf(entry.check.id)))) {
    dimensions[dimension] = toScore(scored.filter((entry) => dimensionOf(entry.check.id) === dimension));
  }
  return {
    score: toScore(scored),
    checks: weightedChecks.map((entry) => entry.check),
    dimensions,
    hardFailure,
  };
}
