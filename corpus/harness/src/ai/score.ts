import type { ExtractionDraft } from "@vendoai/vendo/extract";
import type { ScorecardCheck, ScorecardScore } from "../scorecard.js";
import { aiExpectedToolIdentity, type AiExpectedTool, type RepoAiExpectations } from "./expectations.js";

/**
 * Deterministic scoring for one AI-extraction run over one corpus repo. Pure
 * functions over canned inputs — no model calls, no filesystem — so CI unit
 * tests cover every rubric branch. The matrix runner feeds it the real
 * pipeline outputs (parsed draft + applyDraft's override result).
 *
 * Dimensions:
 * - draft validity (schema) — hard failure when the agent output is unusable;
 * - guard outcomes — model-error refusals (hallucinated names, malformed
 *   wakes) plus false-refusal detection (guard-blocked downgrades the labels
 *   agree with — a pipeline signal, never a scored penalty on its own);
 * - description quality proxies — coverage, non-mechanical, length bounds,
 *   mentions of the bound resource;
 * - risk-grade accuracy + critical marks against ai-expected.json labels;
 * - wake correctness for statically-unclassifiable (disabled) tools;
 * - brief quality proxy (paragraph-sized).
 */

export type AiRiskLabel = "read" | "write" | "destructive";

/** The static-extraction facts the scorer joins on: one entry of
 * `.vendo/tools.json`, reduced to name/description/risk/disabled plus the
 * binding identity in the expectations key format (`GET\t/api/x`,
 * `trpc\tx.y`, ...). */
export interface AiScoredStaticTool {
  name: string;
  description?: string;
  risk?: AiRiskLabel;
  critical?: boolean;
  disabled?: boolean;
  identity: string;
}

/** The per-tool override applyDraft produced on a clean scratch root. */
export interface AiToolOverrideResult {
  risk?: AiRiskLabel;
  critical?: boolean;
  disabled?: boolean;
  description?: string;
}

export interface ScoreAiExtractionInput {
  staticTools: readonly AiScoredStaticTool[];
  /** null = the agent's output never parsed into a valid draft. */
  draft: ExtractionDraft | null;
  draftError?: string;
  overrides: Readonly<Record<string, AiToolOverrideResult>>;
  expected: RepoAiExpectations | null;
}

export interface AiExtractionScore {
  score: ScorecardScore;
  checks: ScorecardCheck[];
  /** Sub-scores grouped by rubric dimension (draft, guards, descriptions,
   * risk, wake, brief) for the scoreboard columns. */
  dimensions: Record<string, ScorecardScore>;
  hardFailure: boolean;
}

const RISK_ORDER: Record<AiRiskLabel, number> = { read: 0, write: 1, destructive: 2 };
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 200;
const BRIEF_MIN = 80;
const BRIEF_MAX = 4000;
const GENERIC_TOKENS = new Set([
  "api", "the", "and", "for", "with", "get", "post", "put", "patch", "delete",
  "new", "all", "app", "route", "routes", "index", "internal",
]);

interface WeightedCheck {
  check: ScorecardCheck;
  /** Points earned on a 0..weight scale; weight 0 = informational only. */
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
  return {
    check: { id, pass: value === 1, detail },
    points: value,
    weight: 1,
  };
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

interface ExpectedJoin {
  label: AiExpectedTool;
  tool: AiScoredStaticTool;
}

/** Labels joined to static tools by binding identity. Labels with no
 * extracted counterpart are a static-extraction recall problem (layer 2's
 * job), surfaced in details but never scored against the AI pass. */
function joinExpected(
  expected: RepoAiExpectations | null,
  staticTools: readonly AiScoredStaticTool[],
): { joined: ExpectedJoin[]; unmatched: AiExpectedTool[] } {
  if (expected === null) return { joined: [], unmatched: [] };
  const byIdentity = new Map(staticTools.map((tool) => [tool.identity, tool]));
  const joined: ExpectedJoin[] = [];
  const unmatched: AiExpectedTool[] = [];
  for (const label of expected.tools) {
    const tool = byIdentity.get(aiExpectedToolIdentity(label));
    if (tool === undefined) unmatched.push(label);
    else joined.push({ label, tool });
  }
  return { joined, unmatched };
}

export function scoreAiExtraction(input: ScoreAiExtractionInput): AiExtractionScore {
  const { staticTools, draft, overrides, expected } = input;
  const byName = new Map(staticTools.map((tool) => [tool.name, tool]));
  const { joined, unmatched } = joinExpected(expected, staticTools);
  const unmatchedNote = unmatched.length > 0
    ? `; ${unmatched.length} labels had no extracted tool (static recall, not scored here)`
    : "";

  const wokenBy = (tool: AiScoredStaticTool): boolean =>
    tool.disabled === true && overrides[tool.name]?.disabled === false;
  const effectiveRisk = (tool: AiScoredStaticTool): AiRiskLabel =>
    overrides[tool.name]?.risk ?? tool.risk ?? "destructive";
  const effectiveCritical = (tool: AiScoredStaticTool): boolean =>
    overrides[tool.name]?.critical ?? tool.critical ?? false;

  // Denominators that must not depend on the draft, so every model's run on
  // the same repo carries the same check set (score.total).
  const describable = staticTools.filter((tool) => tool.disabled !== true);
  const riskJudgeable = (): ExpectedJoin[] =>
    joined.filter(({ tool }) => tool.disabled !== true || wokenBy(tool));
  const criticalLabels = joined.filter(({ label }) => label.critical === true);
  const wakeLabels = joined.filter(({ tool }) => tool.disabled === true);

  const checks: WeightedCheck[] = [];

  if (draft === null) {
    // Same check ids and weights as a valid run, all at zero points: a model
    // whose output never parses floors the whole scoreboard row.
    checks.push({
      check: {
        id: "ai.draft.valid",
        pass: false,
        detail: `draft did not validate: ${input.draftError ?? "unknown error"}`,
      },
      points: 0,
      weight: 1,
    });
    const zero = (id: string): WeightedCheck => ({
      check: { id, pass: false, detail: "no valid draft to judge" },
      points: 0,
      weight: 1,
    });
    checks.push(zero("ai.guards.clean"));
    checks.push({
      check: { id: "ai.guards.false-refusals", pass: true, detail: "no valid draft to judge" },
      points: 0,
      weight: 0,
    });
    checks.push(zero("ai.descriptions.coverage"));
    checks.push(zero("ai.descriptions.non-mechanical"));
    checks.push(zero("ai.descriptions.length"));
    checks.push(zero("ai.descriptions.mentions-resource"));
    checks.push(zero("ai.brief.drafted"));
    if (expected !== null && joined.length > 0) checks.push(zero("ai.risk.accuracy"));
    if (criticalLabels.length > 0) checks.push(zero("ai.risk.critical"));
    if (wakeLabels.length > 0) checks.push(zero("ai.wake.correct"));
    return finalize(checks, true);
  }

  checks.push({
    check: { id: "ai.draft.valid", pass: true, detail: "agent output parsed into a valid draft" },
    points: 1,
    weight: 1,
  });

  // Guard outcomes. Model errors mirror applyDraft's refusal rules exactly:
  // a name outside the static set, or a wake without reasoning + risk.
  const modelErrors: string[] = [];
  const falseRefusals: string[] = [];
  const expectedByIdentity = new Map(joined.map(({ label, tool }) => [tool.identity, label]));
  for (const entry of draft.tools) {
    const fact = byName.get(entry.name);
    if (fact === undefined) {
      modelErrors.push(`${entry.name}: not an extracted tool`);
      continue;
    }
    const isWake = entry.disabled === false && fact.disabled === true;
    if (isWake && (entry.reasoning === undefined || entry.risk === undefined)) {
      modelErrors.push(`${entry.name}: wake without reasoning and risk`);
    }
    if (!isWake && fact.disabled !== true && entry.risk !== undefined) {
      const current = fact.risk ?? "destructive";
      if (RISK_ORDER[entry.risk] < RISK_ORDER[current]) {
        const label = expectedByIdentity.get(fact.identity);
        if (label !== undefined && label.risk === entry.risk) {
          falseRefusals.push(`${entry.name} ${current}→${entry.risk}`);
        }
      }
    }
  }
  checks.push(weighted(
    "ai.guards.clean",
    draft.tools.length - modelErrors.length,
    draft.tools.length,
    modelErrors.length === 0
      ? `${draft.tools.length} draft entries passed the deterministic guards`
      : `${modelErrors.length}/${draft.tools.length} draft entries refused as model errors: ${modelErrors.join("; ")}`,
  ));
  checks.push({
    check: {
      id: "ai.guards.false-refusals",
      pass: true,
      detail: falseRefusals.length === 0
        ? "no guard-blocked downgrades contradict the labels"
        : `${falseRefusals.length} false refusal${falseRefusals.length === 1 ? "" : "s"} — the guard blocked downgrades the labels agree with (static grade is wrong-high): ${falseRefusals.join("; ")}`,
    },
    points: 0,
    weight: 0,
  });

  // Description quality proxies over drafted entries that name real tools.
  const judged = draft.tools
    .map((entry) => ({ entry, fact: byName.get(entry.name) }))
    .filter((pair): pair is { entry: typeof pair.entry; fact: AiScoredStaticTool } => pair.fact !== undefined);
  const describedNames = new Set(judged.map(({ fact }) => fact.name));
  const covered = describable.filter((tool) => describedNames.has(tool.name)).length;
  checks.push(weighted(
    "ai.descriptions.coverage",
    covered,
    describable.length,
    `${covered}/${describable.length} enabled tools received a drafted description`,
  ));

  const nonMechanical = judged.filter(({ entry, fact }) => !isMechanicalDescription(entry.description, fact.description)).length;
  checks.push(weighted(
    "ai.descriptions.non-mechanical",
    nonMechanical,
    judged.length,
    `${nonMechanical}/${judged.length} drafted descriptions differ from the path-derived defaults`,
  ));

  const inBounds = judged.filter(({ entry }) => {
    const length = entry.description.trim().length;
    return length >= DESCRIPTION_MIN && length <= DESCRIPTION_MAX;
  }).length;
  checks.push(weighted(
    "ai.descriptions.length",
    inBounds,
    judged.length,
    `${inBounds}/${judged.length} drafted descriptions are within ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} chars`,
  ));

  const judgeableMentions = judged.filter(({ fact }) => resourceTokens(fact.identity).length > 0);
  const mentions = judgeableMentions.filter(({ entry, fact }) => mentionsResource(entry.description, resourceTokens(fact.identity))).length;
  checks.push(weighted(
    "ai.descriptions.mentions-resource",
    mentions,
    judgeableMentions.length,
    `${mentions}/${judgeableMentions.length} drafted descriptions mention the bound resource`,
  ));

  const briefLength = draft.brief.trim().length;
  const briefOk = briefLength >= BRIEF_MIN && briefLength <= BRIEF_MAX;
  checks.push({
    check: {
      id: "ai.brief.drafted",
      pass: briefOk,
      detail: briefOk
        ? `brief drafted (${briefLength} chars)`
        : `brief is ${briefLength} chars; expected a ${BRIEF_MIN}-${BRIEF_MAX} char paragraph`,
    },
    points: briefOk ? 1 : 0,
    weight: 1,
  });

  // Label-driven dimensions.
  if (expected !== null && joined.length > 0) {
    const judgeable = riskJudgeable();
    const riskMatches = judgeable.filter(({ label, tool }) => effectiveRisk(tool) === label.risk);
    checks.push(weighted(
      "ai.risk.accuracy",
      riskMatches.length,
      judgeable.length,
      `${riskMatches.length}/${judgeable.length} labeled tools ended at the expected risk grade${unmatchedNote}`,
    ));
  }
  if (criticalLabels.length > 0) {
    const criticalMatches = criticalLabels.filter(({ tool }) => effectiveCritical(tool)).length;
    checks.push(weighted(
      "ai.risk.critical",
      criticalMatches,
      criticalLabels.length,
      `${criticalMatches}/${criticalLabels.length} expected critical marks were applied`,
    ));
  }
  if (wakeLabels.length > 0) {
    const wrong: string[] = [];
    for (const { label, tool } of wakeLabels) {
      const woken = wokenBy(tool);
      const correct = label.wake === false
        ? !woken
        : woken && effectiveRisk(tool) === label.risk;
      if (!correct) {
        wrong.push(`${tool.name} (${label.wake === false ? "must stay asleep" : `expected woken as ${label.risk}`})`);
      }
    }
    checks.push(weighted(
      "ai.wake.correct",
      wakeLabels.length - wrong.length,
      wakeLabels.length,
      wrong.length === 0
        ? `${wakeLabels.length}/${wakeLabels.length} unclassifiable tools got the labeled wake decision`
        : `${wakeLabels.length - wrong.length}/${wakeLabels.length} wake decisions matched the labels; wrong: ${wrong.join("; ")}`,
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

function finalize(weightedChecks: readonly WeightedCheck[], hardFailure: boolean): AiExtractionScore {
  const scored = weightedChecks.filter((entry) => entry.weight > 0);
  const dimensions: Record<string, ScorecardScore> = {};
  for (const dimension of new Set(scored.map((entry) => entry.check.id.split(".")[1] ?? "other"))) {
    dimensions[dimension] = toScore(scored.filter((entry) => entry.check.id.split(".")[1] === dimension));
  }
  return {
    score: toScore(scored),
    checks: weightedChecks.map((entry) => entry.check),
    dimensions,
    hardFailure,
  };
}
