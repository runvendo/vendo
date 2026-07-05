/**
 * Deterministic grant matching (ENG-193 spec §4.3). Pure structural checks —
 * no model in the loop. Every uncertainty fails closed to "no match" (the
 * call then simply asks, which is always safe).
 */
import type { PermissionGrant } from "@vendoai/core";
import type { ToolDescriptor } from "../descriptor";
import { canonicalJson, fnv1a64, hashDescriptor } from "../automations/grants";

export function hashInput(input: unknown): string {
  return fnv1a64(canonicalJson(input));
}

export interface GrantMatchContext {
  tool: string;
  descriptor: ToolDescriptor;
  input: unknown;
  /** ISO timestamp for expiry checks. */
  now: string;
  /** Current session/task key for non-standing grants. */
  contextKey?: string;
}

function getByPath(obj: unknown, dotPath: string): unknown {
  let cursor: unknown = obj;
  for (const seg of dotPath.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** Glob with `*` wildcards only, anchored both ends, case-insensitive.
 *  Exported: `policy/rule-match.ts` reuses this verbatim for tighten-rule
 *  matching (ENG-193 item-6) so a rule's semantics never drift from a
 *  grant's `"matches"` constraint. */
export function globMatches(pattern: string, value: string): boolean {
  // ReDoS guard: absurd wildcard counts fail closed (no match → the call
  // simply asks) instead of building a pathological regex.
  if ((pattern.match(/\*/g)?.length ?? 0) > 8) return false;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export type ConstraintCheck = { path: string; op: "eq" | "lte" | "gte" | "matches"; value: string | number | boolean };

/**
 * Three-way constraint result — "unevaluable" (missing path, or a type
 * mismatch for an op that requires one) is kept distinct from a definite
 * "no-match" so callers can choose their own failure direction:
 * `constraintHolds` (grants) collapses both to `false` (fail CLOSED to no
 * match — a grant must never fire on a guess); `rule-match.ts` (tighten
 * rules, ENG-193 item-6 ruling #4) treats "unevaluable" as MATCHING instead
 * — the opposite direction is correct there: an always-ask rule that can't
 * tell whether the live input excludes it should still ask, not go silent.
 * Exported for that one caller; not part of the general policy surface.
 */
export function constraintResult(
  input: unknown,
  c: ConstraintCheck,
): "match" | "no-match" | "unevaluable" {
  const actual = getByPath(input, c.path);
  if (actual === undefined) return "unevaluable"; // missing path — can't tell
  switch (c.op) {
    case "eq":
      return actual === c.value ? "match" : "no-match";
    case "lte":
      if (typeof actual !== "number" || typeof c.value !== "number") return "unevaluable";
      return actual <= c.value ? "match" : "no-match";
    case "gte":
      if (typeof actual !== "number" || typeof c.value !== "number") return "unevaluable";
      return actual >= c.value ? "match" : "no-match";
    case "matches":
      if (typeof actual !== "string" || typeof c.value !== "string") return "unevaluable";
      return globMatches(c.value, actual) ? "match" : "no-match";
  }
}

/** Exported for the same reason as `globMatches` above. Fails CLOSED to no
 *  match on anything unevaluable (grants only ever fire on a provable hit). */
export function constraintHolds(input: unknown, c: ConstraintCheck): boolean {
  return constraintResult(input, c) === "match";
}

export function grantMatches(grant: PermissionGrant, ctx: GrantMatchContext): boolean {
  if (grant.tool !== ctx.tool) return false;
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && grant.expiresAt <= ctx.now) return false;
  if (grant.descriptorHash !== hashDescriptor(ctx.descriptor)) return false;
  if (grant.duration !== "standing") {
    if (grant.contextKey === undefined || ctx.contextKey === undefined) return false;
    if (grant.contextKey !== ctx.contextKey) return false;
  }
  switch (grant.scope.kind) {
    case "tool":
      return true;
    case "exact":
      return grant.scope.inputHash === hashInput(ctx.input);
    case "constrained":
      return grant.scope.constraints.every((c) => constraintHolds(ctx.input, c));
  }
}
