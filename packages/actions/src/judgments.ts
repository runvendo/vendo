import type { GradedRiskLabel } from "@vendoai/core";
import { bindingIdentity } from "./binding-identity.js";
import type { ExtractedTool, JudgmentFields, JudgmentsFile, PendingLoosening, ToolJudgment } from "./formats.js";

/**
 * The judgment layer's deterministic half: the direction rule that decides
 * which half of a model's proposal may land and which half waits for a human.
 *
 * The safety property is one-way and absolute. A judgment may make a tool MORE
 * restrictive on its own — raise risk, narrow audience, disable, mark confirmEach,
 * rewrite prose. It may never make one LESS restrictive: lowering risk, widening
 * audience, waking a disabled tool, or clearing a confirmEach mark is a human act.
 * Those do not get refused and forgotten (the old clamp's failure: a real
 * finding evaporated into a log line) — they are QUEUED as `pending` on the
 * judgment, each with its own evidence, and stay inert at runtime until a human
 * accepts them. Direction is computed against the tool's EFFECTIVE state
 * (skeleton ⊕ the standing judgment), so accepted judgments only ratchet
 * tighter and an over-tight call is undone by a human, never by the next model
 * run. Tool identity, bindings, and inputSchema are not expressible here:
 * `JudgmentFields` is the whole AI-writable surface.
 */

/** Restrictiveness order over the grades someone actually assigned.
 *  `ungraded` is the ABSENCE of a grade, so it is not a rung here —
 *  `classifyField` handles it directly. */
export const RISK_RANK = { read: 0, write: 1, destructive: 2 } as const;

/** Audience narrowing order: an ungraded tool behaves as end-user-visible, so
 *  end-user is the widest grade and internal the narrowest (non-end-user
 *  grades exclude the tool from the embedded agent by default). */
export const AUDIENCE_RANK = { "end-user": 0, operator: 1, internal: 2 } as const;

/** One tool's proposal from the judge: the writable fields plus the evidence
 *  every queued loosening inherits. Evidence is required because a loosening
 *  cannot exist without it. */
export interface JudgmentProposal extends JudgmentFields {
  evidence: string;
  reason?: string;
}

/** The four capability grades a loosening can touch. Prose is not among them:
 *  a description has no loose/tight direction, and the AI is its sole author. */
const CAPABILITY_FIELDS = ["risk", "confirmEach", "disabled", "audience"] as const;

type CapabilityField = (typeof CAPABILITY_FIELDS)[number];

const isCapabilityField = (field: keyof JudgmentFields): field is CapabilityField =>
  (CAPABILITY_FIELDS as readonly string[]).includes(field);

/**
 * Which way one proposed field moves the tool. "harden" = at least as
 * restrictive as the tool's current state (a restatement is a harmless no-op
 * the caller drops); "loosen" = strictly less restrictive, which never applies
 * itself. Prose and semantics route with the hardenings: there is no direction
 * to a description, and the AI is the sole author of one.
 */
export function classifyField(
  tool: ExtractedTool,
  field: keyof JudgmentFields,
  value: unknown,
): "harden" | "loosen" {
  if (field === "risk") {
    // Grading an `ungraded` tool is the GRADING, not a relaxation of one: the
    // judge and a human are both authorized graders (D2), and holding the
    // first grade for review would leave every keyless catalog blank forever.
    // Trading a real grade back for a blank is the loosening a human owns.
    if (tool.risk === "ungraded") return "harden";
    if (value === "ungraded") return "loosen";
    return RISK_RANK[value as GradedRiskLabel] >= RISK_RANK[tool.risk] ? "harden" : "loosen";
  }
  if (field === "audience") {
    // An ungraded baseline behaves as end-user-visible: any grade on it is
    // provenance or a narrowing, never a widen.
    const current = AUDIENCE_RANK[tool.audience ?? "end-user"];
    return AUDIENCE_RANK[value as NonNullable<ExtractedTool["audience"]>] >= current ? "harden" : "loosen";
  }
  if (field === "confirmEach" || field === "disabled") return value === true ? "harden" : "loosen";
  return "harden";
}

/**
 * Split one proposal against the tool's EFFECTIVE current state — pass the
 * entry `applyJudgment` already returned, not the raw `tools.json` skeleton, or
 * a standing judgment's own grade reads as a fresh hardening. No-ops (a field
 * restating what already holds) drop from both sides.
 */
export function splitProposal(tool: ExtractedTool, proposal: JudgmentProposal): {
  hardenings: JudgmentFields;
  loosenings: PendingLoosening[];
} {
  const { evidence, reason, ...fields } = proposal;
  const hardenings: JudgmentFields = {};
  const loosenings: PendingLoosening[] = [];

  for (const [field, value] of Object.entries(fields) as Array<[keyof JudgmentFields, unknown]>) {
    if (value === undefined) continue;
    if (isNoOp(tool, field, value)) continue;
    if (classifyField(tool, field, value) === "harden") {
      Object.assign(hardenings, { [field]: value });
      continue;
    }
    // Only the capability grades are loosenable, and classifyField never routes
    // anything else here.
    if (!isCapabilityField(field)) continue;
    loosenings.push({
      field,
      value: value as string | boolean,
      evidence,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return { hardenings, loosenings };
}

/** A field restating what the tool already carries. Semantics are exempt: they
 *  merge per key, so any proposed map is a real (additive) change. */
function isNoOp(tool: ExtractedTool, field: keyof JudgmentFields, value: unknown): boolean {
  if (field === "confirmEach" || field === "disabled") return value === (tool[field] ?? false);
  if (field === "semantics") return Object.keys(value as Record<string, unknown>).length === 0;
  return value === tool[field];
}

/**
 * Apply a standing judgment to one tool. The judgment's `binding` is checked
 * against the tool's identity first: a judgment of a handler that moved is
 * INERT, never re-pointed at whatever now answers under that name. `pending` is
 * never applied — those wait for a human.
 */
export function applyJudgment(tool: ExtractedTool, judgment: ToolJudgment | undefined): ExtractedTool {
  if (judgment === undefined || judgment.binding !== bindingIdentity(tool.binding)) return tool;
  const { semantics, ...rest } = judgment.fields;
  const merged: ExtractedTool = { ...tool, ...rest };
  // Proposed semantics merge PER KEY over the tool's inferred hints — a
  // judgment corrects individual fields, it never wipes the inference.
  if (semantics !== undefined) merged.semantics = { ...tool.semantics, ...semantics };
  // Fail-closed exclusion (mirrors init's applyDraft): a non-end-user grade
  // excludes the tool from the embedded agent by default.
  if ((merged.audience === "operator" || merged.audience === "internal") && merged.disabled !== true) {
    merged.disabled = true;
  }
  return merged;
}

/**
 * Why one host tool is off, named for the layer that turned it off, or
 * undefined when it is live. The human's override wins the merge, so it is
 * checked first; an audience grade is the fail-closed exclusion `applyJudgment`
 * adds above, and it is the only reason no file states outright — which is
 * exactly how a graded tool used to vanish in silence.
 */
export function disabledReason(
  tool: ExtractedTool,
  judgment: ToolJudgment | undefined,
  override: { disabled?: boolean } | undefined,
): string | undefined {
  const judged = applyJudgment(tool, judgment);
  if ((override?.disabled ?? judged.disabled ?? false) !== true) return undefined;
  if (override?.disabled === true) return "turned off in .vendo/overrides.json";
  // Binding-checked exactly as `applyJudgment` checks it: a judgment of a
  // handler that moved is inert, so naming it would send the developer to edit
  // the one file that did not turn this tool off.
  if (judgment?.fields.disabled === true && judgment.binding === bindingIdentity(tool.binding)) {
    return "turned off in .vendo/judgments.json";
  }
  if (judged.audience !== undefined && judged.audience !== "end-user") {
    return `graded audience "${judged.audience}", and only end-user tools are on by default`;
  }
  return "turned off in .vendo/tools.json";
}

/**
 * Drop judgments that no longer describe anything: a name the current catalog
 * does not carry, or one whose binding moved. Keeps the file honest instead of
 * accumulating inert entries a human would have to read past.
 */
export function pruneJudgments(file: JudgmentsFile, tools: ExtractedTool[]): JudgmentsFile {
  const identityByName = new Map(tools.map((tool) => [tool.name, bindingIdentity(tool.binding)]));
  const kept: Record<string, ToolJudgment> = {};
  for (const [name, judgment] of Object.entries(file.tools)) {
    if (identityByName.get(name) === judgment.binding) kept[name] = judgment;
  }
  return { ...file, tools: kept };
}
