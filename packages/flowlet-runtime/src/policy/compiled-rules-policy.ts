/**
 * compiledRulesPolicy (ENG-193 §4.8, item-6 scope ruling #3) — the TIGHTEN
 * half of conversational steering. A SIBLING layer, composed OUTSIDE
 * `grantPolicy`, never nested inside it: a matching always-ask rule must
 * beat any grant/fade/judge-allow, and `composePolicy`'s existing
 * most-restrictive-wins semantics already guarantees that for any sibling
 * that returns "approve" while another returns "allow" — no new precedence
 * logic is needed for this invariant (unlike `auditPolicy`, which must
 * observe another sibling's stamped state and so must run LAST in the
 * composed chain; this layer has no such ordering requirement).
 *
 * Reads never escalate here (Moment 1's "reads just flow" is not this
 * layer's to break, even if a badly-scoped `toolPattern` glob happens to
 * also match a read-tier tool name). A rule matching a CRITICAL tool is a
 * harmless no-op — critical already always asks via the type-level check
 * other layers own — so it is not specially handled here either.
 */
import type { CompiledRuleStore, Principal } from "@flowlet/core";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import { dangerTier } from "./tier";
import { ruleMatches } from "./rule-match";

export interface CompiledRulesPolicyOptions {
  /** Maps the policy principal to the store's Principal scope. */
  principalScope: (ctx: PolicyContext) => Principal;
}

export function compiledRulesPolicy(
  store: CompiledRuleStore,
  opts: CompiledRulesPolicyOptions,
): ApprovalPolicy {
  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      if (dangerTier(ctx.descriptor) === "read") return "allow"; // Moment 1 is untouchable
      const rules = await store.list(opts.principalScope(ctx));
      const matched = rules.some((r) => ruleMatches(r, { tool: ctx.toolName, input: ctx.input }));
      return matched ? "approve" : "allow";
    },
  };
}
