/**
 * The production policy stack (ENG-193 §4.2/§4.3/§4.7/§6.2), applied to
 * whatever BASE policy the host runs — `options.policy ?? defaultFlowletPolicy`.
 *
 *   audit ⊕ volumeBreaker(cautionBreaker(judgePolicy(grantPolicy(base))))
 *
 * `composePolicy` is most-restrictive-wins across the two top-level siblings
 * (`auditPolicy`, always "allow"; the breaker/judge/grant chain). Within that
 * chain, nesting order is load-bearing — see `judge-policy.ts` and
 * `breakers.ts`'s own docstrings for why `cautionBreaker` must sit directly
 * on `judgePolicy`'s output. `contextKey: threadId` (§4.3) keys
 * session/task-duration grants to one conversation.
 */
import type { AuditLog, GrantStore, Principal } from "@flowlet/core";
import type { LanguageModel } from "ai";
import {
  auditPolicy,
  composePolicy,
  grantPolicy,
  judgePolicy,
  volumeBreaker,
  cautionBreaker,
  createBreakerState,
  type ApprovalPolicy,
  type BreakerState,
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
  deps: {
    grants: GrantStore;
    audit: AuditLog;
    now?: () => string;
    /** Absent -> the judge layer is IDENTITY (ENG-193 §4.2 fail-safe default). */
    judgeModel?: LanguageModel;
    /** Injectable so a host can persist/reset it like grants/audit/threads.
     *  Defaults to a fresh in-memory instance. */
    breakers?: BreakerState;
  },
): ApprovalPolicy {
  const breakerState = deps.breakers ?? createBreakerState();
  return composePolicy(
    auditPolicy(deps.audit, {
      principalScope,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    volumeBreaker(
      cautionBreaker(
        judgePolicy(
          grantPolicy(base, deps.grants, {
            principalScope,
            contextKey: (ctx) => ctx.threadId,
            ...(deps.now ? { now: deps.now } : {}),
          }),
          { model: deps.judgeModel },
        ),
        breakerState,
      ),
      breakerState,
    ),
  );
}
