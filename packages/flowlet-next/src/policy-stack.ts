/**
 * The item-1 production policy stack (ENG-193 §4.3/§6.2), applied to whatever
 * BASE policy the host runs — `options.policy ?? defaultFlowletPolicy` (see
 * the ENG-193 item-2 plan's "Plan deviations" #4: the scope ruling's
 * `annotationPolicy()` snippet is illustrative; wrapping the host's real base
 * layer is the intent). Order matters only for clarity, not correctness:
 * `composePolicy` is most-restrictive-wins, the audit layer always
 * contributes "allow", and `grantPolicy` refuses to suppress critical by type
 * BEFORE any grant lookup (item-1 invariant §8.1).
 *
 * `contextKey: threadId` (§4.3) keys session/task-duration grants to one
 * conversation; the standing grants item 2 mints ignore it.
 */
import type { AuditLog, GrantStore, Principal } from "@flowlet/core";
import {
  auditPolicy,
  composePolicy,
  grantPolicy,
  type ApprovalPolicy,
  type PolicyContext,
} from "@flowlet/runtime";

export const EMBEDDED_TENANT = "flowlet-embedded";

/** The handler's fixed Principal mapping: one embedded tenant, subject = the
 *  resolved FlowletPrincipal's userId (same scope shape world.ts uses). */
export function principalScope(ctx: PolicyContext): Principal {
  return { tenantId: EMBEDDED_TENANT, subject: ctx.principal.userId };
}

export function composeProductionPolicy(
  base: ApprovalPolicy,
  deps: { grants: GrantStore; audit: AuditLog; now?: () => string },
): ApprovalPolicy {
  return composePolicy(
    auditPolicy(deps.audit, {
      principalScope,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    grantPolicy(base, deps.grants, {
      principalScope,
      contextKey: (ctx) => ctx.threadId,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
}
