/**
 * The production policy stack (ENG-193 §4.2/§4.3/§4.7/§6.2), applied to
 * whatever BASE policy the host runs — `options.policy ?? defaultFlowletPolicy`.
 *
 *   volumeBreaker(cautionBreaker(judgePolicy(grantPolicy(base)))) ⊕ compiledRulesPolicy(rules) ⊕ audit
 *
 * `composePolicy` is most-restrictive-wins across the top-level siblings
 * (the breaker/judge/grant chain; `compiledRulesPolicy`, ENG-193 item 6's
 * tighten rules; `auditPolicy`, always "allow"). SIBLING
 * ORDER IS LOAD-BEARING: `composePolicy` evaluates siblings in order with
 * one shared ctx, and `auditPolicy` must come LAST so its evaluate observes
 * the escalation reason the chain just stamped — that's what gives a
 * DECLINED escalation its `judge_escalation` audit entry (see
 * audit-policy.ts's composition contract). Within the chain, nesting order
 * is load-bearing too — see `judge-policy.ts` and `breakers.ts`'s own
 * docstrings for why `cautionBreaker` must sit directly on `judgePolicy`'s
 * output. `contextKey: threadId` (§4.3) keys session/task-duration grants
 * to one conversation.
 */
import type { AuditLog, CompiledRuleStore, GrantStore, Principal } from "@flowlet/core";
import type { LanguageModel } from "ai";
import {
  auditPolicy,
  composePolicy,
  compiledRulesPolicy,
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
    /** ENG-193 item 6 — tighten rules. Required (not optional) here: this
     *  function is the ONE production assembly point, and a host that omits
     *  it would silently lose the tighten guarantee rather than getting a
     *  loud type error. Callers with no rules yet pass a fresh in-memory
     *  store — an empty store never matches anything. */
    rules: CompiledRuleStore;
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
    // Item 6: a matching always-ask rule beats any grant/judge/breaker allow.
    // A SIBLING, not nested inside the chain above — composePolicy's
    // most-restrictive-wins already gives it precedence with no new ordering
    // logic (see compiled-rules-policy.ts's own docstring for why this
    // doesn't need auditPolicy's "must run last" treatment).
    compiledRulesPolicy(deps.rules, { principalScope }),
    // LAST on purpose — must observe the reason the chain stamped (see docstring).
    auditPolicy(deps.audit, {
      principalScope,
      ...(deps.now ? { now: deps.now } : {}),
    }),
  );
}
