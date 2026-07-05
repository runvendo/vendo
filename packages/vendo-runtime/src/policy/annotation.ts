/**
 * Annotation-based policy layer for the Vendo guardrail engine.
 *
 * Derives an `ApprovalDecision` from the `ToolAnnotations` captured at
 * registration time. Decision precedence (most → least restrictive signal):
 *
 * 1. `destructiveHint || openWorldHint` → `"approve"` (explicit risk)
 * 2. `readOnlyHint`                    → `"allow"`   (explicitly safe)
 * 3. no informative hints              → `"approve"` (fail-safe: gate the unknown)
 */

import type { ApprovalPolicy, ApprovalDecision, PolicyContext } from "./types";

/**
 * Build a policy layer that maps a tool's annotation hints to an approval
 * decision. See module-level docstring for the full precedence table.
 */
export function annotationPolicy(): ApprovalPolicy {
  return {
    evaluate(ctx: PolicyContext): ApprovalDecision {
      const { destructiveHint, openWorldHint, readOnlyHint } =
        ctx.descriptor.annotations;

      if (destructiveHint === true || openWorldHint === true) {
        return "approve";
      }

      if (readOnlyHint === true) {
        return "allow";
      }

      // No informative hints — fail-safe: require approval for unknown tools.
      return "approve";
    },
  };
}
