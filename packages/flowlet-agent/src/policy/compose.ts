/**
 * Policy composition for the Flowlet guardrail engine.
 *
 * `composePolicy` runs all given layers and returns the most restrictive
 * `ApprovalDecision`. Severity order: `allow` (0) < `approve` (1) < `deny` (2).
 */

import type { ApprovalPolicy, ApprovalDecision, PolicyContext } from "./types";

const RANK: Record<ApprovalDecision, number> = {
  allow: 0,
  approve: 1,
  deny: 2,
};

const BY_RANK: ApprovalDecision[] = ["allow", "approve", "deny"];

/**
 * Compose multiple `ApprovalPolicy` layers into a single policy that returns
 * the most restrictive decision across all layers.
 *
 * - Zero policies → `"allow"` (open by default, nothing to restrict).
 * - May short-circuit after a `"deny"` since no decision is more restrictive.
 * - All layers are awaited regardless of whether they return synchronously.
 */
export function composePolicy(...policies: ApprovalPolicy[]): ApprovalPolicy {
  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      let maxRank = 0; // starts at rank of "allow"

      for (const policy of policies) {
        const decision = await policy.evaluate(ctx);
        const rank = RANK[decision];
        if (rank > maxRank) {
          maxRank = rank;
        }
        // Short-circuit: "deny" is maximally restrictive
        if (maxRank === RANK.deny) {
          break;
        }
      }

      return BY_RANK[maxRank]!;
    },
    async onExecuted(
      ctx: PolicyContext,
      decision: ApprovalDecision,
    ): Promise<void> {
      // Propagate the post-execute signal — including the enforced decision —
      // to every layer that defines it so each can record that the call
      // genuinely ran under that decision.
      for (const policy of policies) {
        await policy.onExecuted?.(ctx, decision);
      }
    },
  };
}
