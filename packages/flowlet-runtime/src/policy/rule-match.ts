/**
 * Deterministic rule matching (ENG-193 spec §4.8, item-6 scope ruling #3) —
 * reuses grant-match's own glob/constraint helpers (`globMatches`,
 * `constraintHolds`) so a tighten rule's matching semantics are IDENTICAL to
 * a grant's, not a parallel reimplementation that could silently drift.
 * Every uncertainty fails closed to "no match" (the call then simply follows
 * whatever the rest of the policy stack would have decided anyway).
 */
import type { CompiledRule } from "@flowlet/core";
import { constraintHolds, globMatches } from "./grant-match";

export interface RuleMatchContext {
  tool: string;
  input: unknown;
}

export function ruleMatches(rule: CompiledRule, ctx: RuleMatchContext): boolean {
  if (rule.revokedAt !== undefined) return false;
  if (!globMatches(rule.toolPattern, ctx.tool)) return false;
  if (rule.constraint && !constraintHolds(ctx.input, rule.constraint)) return false;
  return true;
}
