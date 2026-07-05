/**
 * Deterministic rule matching (ENG-193 spec §4.8, item-6 scope ruling #3) —
 * reuses grant-match's own glob/constraint helpers (`globMatches`,
 * `constraintResult`) so a tighten rule's matching semantics are IDENTICAL to
 * a grant's, not a parallel reimplementation that could silently drift.
 *
 * The tool-pattern glob still fails closed to "no match" on the ReDoS guard —
 * that's a static, spec-time property of the rule's own pattern, not a
 * live-input uncertainty. The CONSTRAINT is different (review follow-up): a
 * grant's `constraintHolds` fails CLOSED on anything unevaluable (missing
 * path, type mismatch) because a grant must only ever fire on a provable
 * hit — but a tighten/always-ask rule exists to make the agent stop and ask,
 * and failing the SAME way here would silently fail OPEN instead: an input
 * shape the rule's author never anticipated (a renamed field, a schema
 * change) would just stop asking. So this inverts on "unevaluable" only —
 * the rule matches (asks) unless the constraint provably EXCLUDES the call
 * (`constraintResult` returns "no-match"). Do not "fix" this to mirror
 * `constraintHolds` — that would reintroduce the fail-open bug this file
 * exists to close.
 */
import type { CompiledRule } from "@vendoai/core";
import { constraintResult, globMatches } from "./grant-match";

export interface RuleMatchContext {
  tool: string;
  input: unknown;
}

export function ruleMatches(rule: CompiledRule, ctx: RuleMatchContext): boolean {
  if (rule.revokedAt !== undefined) return false;
  if (!globMatches(rule.toolPattern, ctx.tool)) return false;
  if (rule.constraint && constraintResult(ctx.input, rule.constraint) === "no-match") return false;
  return true;
}
