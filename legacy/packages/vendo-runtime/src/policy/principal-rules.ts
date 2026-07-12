/**
 * Principal-driven policy layers for the Vendo guardrail engine.
 *
 * Two layers are provided:
 * - `thresholdRule` — gates a numeric input argument against a per-principal limit.
 * - `roleRule`      — denies access unless the principal holds a required role.
 */

import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk `obj` along `dotPath` (e.g. `"transfer.usd"`) and return the leaf
 * value, or `undefined` if any segment is missing or the receiver is not an
 * object.
 */
function getByPath(obj: unknown, dotPath: string): unknown {
  const segments = dotPath.split(".");
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// thresholdRule
// ---------------------------------------------------------------------------

/**
 * Build a policy layer that triggers an approval gate when a numeric argument
 * from the tool input exceeds a per-principal limit.
 *
 * @param opts.argPath   Dot-path into `ctx.input` pointing at the numeric value
 *                       (e.g. `"amount"` or `"transfer.usd"`).
 * @param opts.limitKey  Key into `ctx.principal.limits` holding the threshold.
 *
 * Returns `"approve"` only when both the value and the limit are numbers AND
 * `value > limit`. In all other cases (missing value, missing limit,
 * non-numeric) it returns `"allow"` so other composed layers can still gate.
 */
export function thresholdRule(opts: {
  argPath: string;
  limitKey: string;
}): ApprovalPolicy {
  return {
    evaluate(ctx: PolicyContext): ApprovalDecision {
      const value = getByPath(ctx.input, opts.argPath);
      const limit = ctx.principal.limits?.[opts.limitKey];

      if (typeof value === "number" && typeof limit === "number" && value > limit) {
        return "approve";
      }

      return "allow";
    },
  };
}

// ---------------------------------------------------------------------------
// roleRule
// ---------------------------------------------------------------------------

/**
 * Build a policy layer that denies tool invocation unless the principal holds
 * `opts.requiredRole`.
 *
 * Returns `"deny"` when the role is absent (including when `roles` is
 * undefined or empty). Returns `"allow"` when the role is present.
 */
export function roleRule(opts: { requiredRole: string }): ApprovalPolicy {
  return {
    evaluate(ctx: PolicyContext): ApprovalDecision {
      if (!ctx.principal.roles?.includes(opts.requiredRole)) {
        return "deny";
      }
      return "allow";
    },
  };
}
