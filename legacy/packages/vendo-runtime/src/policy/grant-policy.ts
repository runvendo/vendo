/**
 * Grant-suppression layer (ENG-193 §4.3) — the successor to the retired
 * ask-once `rememberDecisions` memoiser, inheriting its fail-closed rules:
 *
 * - Suppression only ever downgrades `approve` → `allow`. A `deny` from the
 *   inner policy always wins, re-evaluated fresh on every call.
 * - CRITICAL IS UNSUPPRESSIBLE BY TYPE: `dangerTier(descriptor) === "critical"`
 *   is checked BEFORE grant lookup — a grant for a dangerous tool can exist in
 *   a corrupted store and still never fire.
 * - Nothing is recorded here. Grants are created only from explicit,
 *   server-validated user consent (the consent channel), never as a side
 *   effect of evaluation or execution.
 */
import type { GrantStore, Principal } from "@vendoai/core";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types.js";
import { dangerTier } from "./tier.js";
import { grantMatches } from "./grant-match.js";

export interface GrantPolicyOptions {
  /** Maps the policy principal to the store's Principal scope. */
  principalScope: (ctx: PolicyContext) => Principal;
  /** Session/task key for non-standing grants; absent → only standing match. */
  contextKey?: (ctx: PolicyContext) => string | undefined;
  now?: () => string;
}

export function grantPolicy(
  inner: ApprovalPolicy,
  store: GrantStore,
  opts: GrantPolicyOptions,
): ApprovalPolicy {
  const clock = opts.now ?? (() => new Date().toISOString());
  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      const decision = await inner.evaluate(ctx);
      if (decision !== "approve") return decision;
      // Type-level refusal: critical never consults grants.
      if (dangerTier(ctx.descriptor) === "critical") return decision;
      const grants = await store.findForTool(opts.principalScope(ctx), ctx.toolName);
      const match = grants.some((g) =>
        grantMatches(g, {
          tool: ctx.toolName,
          descriptor: ctx.descriptor,
          input: ctx.input,
          now: clock(),
          contextKey: opts.contextKey?.(ctx),
        }),
      );
      return match ? "allow" : decision;
    },
    async onExecuted(ctx, decision) {
      await inner.onExecuted?.(ctx, decision);
    },
  };
}
