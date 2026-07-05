/**
 * ENG-193 §8 invariant tests — PERMANENT. These encode the safety contract of
 * the permission system; a PR that breaks one of these is wrong by definition
 * (see docs/superpowers/specs/2026-07-02-eng193-permissions-design.md §8).
 */
import { describe, expect, it } from "vitest";
import type { Principal } from "@flowlet/core";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { buildDescriptor, type ToolDescriptor } from "../descriptor";
import { createInMemoryGrantStore } from "../grant-store";
import { createGrantManager } from "../grant-manager";
import { InMemoryAuditLog } from "../embedded/in-memory-store";
import { hashDescriptor } from "../automations/grants";
import { createAutomationTools } from "../automations/tools";
import { AutomationRunner } from "../automations/runner";
import { InMemoryAutomationStore } from "../automations/store";
import { annotationPolicy } from "./annotation";
import { composePolicy } from "./compose";
import { grantPolicy } from "./grant-policy";
import { roleRule } from "./principal-rules";
import { dangerTier, isUnverified } from "./tier";
import type { PolicyContext } from "./types";
import { judgePolicy } from "./judge-policy";
import { cautionBreaker, createBreakerState, volumeBreaker } from "./breakers";
import { getEscalationReason, setEscalationReason } from "./escalation";
import type { ApprovalPolicy } from "./types";
import type { FlowletUIMessage } from "@flowlet/core";
import { createFadeTracker } from "../fade-tracker";
import { handleConsent } from "../consent";
import { handleFadeProposal } from "../fade-proposal";
import { compiledRulesPolicy } from "./compiled-rules-policy";
import { createInMemoryCompiledRuleStore } from "../rule-store";
import { createSteeringTools } from "../steering-tools";

const scope: Principal = { tenantId: "t", subject: "u" };

const readDesc: ToolDescriptor = {
  name: "get_x",
  source: "caller",
  annotations: { readOnlyHint: true },
  hasExecute: true,
  kind: "function",
};
const actDesc: ToolDescriptor = {
  name: "send_email",
  source: "caller",
  annotations: { readOnlyHint: false },
  hasExecute: true,
  kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money",
  source: "caller",
  annotations: { destructiveHint: true },
  hasExecute: true,
  kind: "function",
};
const engineActDesc: ToolDescriptor = {
  name: "always_ask_before",
  source: "engine",
  annotations: { readOnlyHint: false, destructiveHint: false },
  hasExecute: true,
  kind: "function",
};

const ctxFor = (descriptor: ToolDescriptor, input: unknown = {}): PolicyContext => ({
  toolName: descriptor.name,
  input,
  descriptor,
  // No roles: the most restrictive default principal.
  principal: { userId: "u" },
});

/** A tool-scope (broadest possible) grant for the given descriptor. */
async function seedToolGrant(
  store: ReturnType<typeof createInMemoryGrantStore>,
  descriptor: ToolDescriptor,
  overrides: { descriptorHash?: string } = {},
): Promise<void> {
  await store.create(scope, {
    tool: descriptor.name,
    descriptorHash: overrides.descriptorHash ?? hashDescriptor(descriptor),
    scope: { kind: "tool" },
    duration: "standing",
    source: { kind: "chat" },
  });
}

describe("ENG-193 §8 permanent invariants", () => {
  it("INVARIANT §8.1: a grant for a critical tool never suppresses the chat approval", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, criticalDesc); // however it got into the store
    const policy = grantPolicy(annotationPolicy(), store, { principalScope: () => scope });
    expect(await policy.evaluate(ctxFor(criticalDesc, { amount: 5 }))).toBe("approve");
  });

  it("INVARIANT §8.2: automation-management tools are critical by descriptor", () => {
    const store = new InMemoryAutomationStore();
    const runner = new AutomationRunner({
      store,
      tools: async () => ({}),
      policy: { evaluate: () => "allow" },
    });
    const toolset = createAutomationTools({
      store,
      runner,
      principal: scope,
      registeredTools: async () => ({}),
    });
    for (const name of ["create_automation", "update_automation", "delete_automation"]) {
      const descriptor = buildDescriptor(name, toolset[name], "engine");
      expect(dangerTier(descriptor), name).toBe("critical");
    }
  });

  it("INVARIANT §8.5: a deny layer wins over a matching grant", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, actDesc);
    const policy = composePolicy(
      roleRule({ requiredRole: "admin" }),
      grantPolicy(annotationPolicy(), store, { principalScope: () => scope }),
    );
    // The principal holds no roles: deny stands despite the matching grant.
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("deny");
  });

  it("INVARIANT §8.6: a stale descriptorHash never suppresses", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, actDesc, { descriptorHash: "stale-manifest-republish" });
    const policy = grantPolicy(annotationPolicy(), store, { principalScope: () => scope });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("approve");
  });

  it("INVARIANT §8.8: the grant manager refuses to create a grant for a critical tool", async () => {
    const mgr = createGrantManager({
      store: createInMemoryGrantStore(),
      audit: new InMemoryAuditLog(),
    });
    await expect(
      mgr.create(
        scope,
        {
          tool: criticalDesc.name,
          scope: { kind: "tool" },
          duration: "standing",
          source: { kind: "chat" },
        },
        criticalDesc,
      ),
    ).rejects.toThrow(/critical/);
  });
});

const ZERO_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
function judgeReturning(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage: ZERO_USAGE, warnings: [],
    }),
  });
}

describe("ENG-193 item 3 — judge + breaker invariants", () => {
  it("INVARIANT: the judge never downgrades critical, even with a matching grant and a 'match' verdict", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, criticalDesc);
    const policy = judgePolicy(
      grantPolicy(annotationPolicy(), store, { principalScope: () => scope }),
      { model: judgeReturning("match") },
    );
    expect(await policy.evaluate({ ...ctxFor(criticalDesc, { amount: 5 }), threadId: "th-1" })).toBe("approve");
  });

  it("INVARIANT: the judge never overrides deny, at any verdict", async () => {
    const denyThenJudge = composePolicy(
      roleRule({ requiredRole: "admin" }), // the principal below holds no roles -> deny
      judgePolicy(annotationPolicy(), { model: judgeReturning("match") }),
    );
    expect(await denyThenJudge.evaluate({ ...ctxFor(actDesc), threadId: "th-1" })).toBe("deny");
  });

  it("INVARIANT: breakers never loosen — a volumeBreaker/cautionBreaker wrapping a deny stays deny", async () => {
    const state = createBreakerState();
    const denyPolicy = { evaluate: () => "deny" as const };
    expect(await volumeBreaker(denyPolicy, state).evaluate({ ...ctxFor(actDesc), threadId: "th-1" })).toBe("deny");
    expect(await cautionBreaker(denyPolicy, state).evaluate({ ...ctxFor(actDesc), threadId: "th-1" })).toBe("deny");
  });

  it("INVARIANT: caution state cannot suppress critical's ceremony", async () => {
    const state = createBreakerState();
    // Trip caution with 3 consecutive escalations on an ACT tool.
    for (let i = 0; i < 3; i++) {
      const escalating = { evaluate: (ctx: PolicyContext) => { setEscalationReason(ctx, "x"); return "approve" as const; } };
      const wrapped = cautionBreaker(escalating, state, { consecutiveThreshold: 3 });
      const ctx = { ...ctxFor(actDesc), threadId: "th-1" };
      await wrapped.evaluate(ctx);
      await wrapped.onExecuted!(ctx, "approve");
    }
    // A critical call, even one the inner layer said "approve" for (as
    // critical always does), is untouched by the now-active caution state.
    const policy = cautionBreaker(annotationPolicy(), state);
    expect(await policy.evaluate({ ...ctxFor(criticalDesc), threadId: "th-1" })).toBe("approve");
  });

  it("INVARIANT: no judge configured -> the stack is IDENTICAL to item-2 behavior across every tier/decision", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, actDesc);
    const withoutJudge = grantPolicy(annotationPolicy(), store, { principalScope: () => scope });
    const wrappedInJudge = judgePolicy(withoutJudge, {}); // no model
    // Every tier cell: read, act, critical.
    for (const descriptor of [readDesc, actDesc, criticalDesc]) {
      const ctx = { ...ctxFor(descriptor), threadId: "th-1" };
      const ctxCopy = { ...ctxFor(descriptor), threadId: "th-1" };
      expect(await wrappedInJudge.evaluate(ctx)).toBe(await withoutJudge.evaluate(ctxCopy));
      // No side-channel writes either: an unset judge must leave the
      // escalation channel untouched for every cell.
      expect(getEscalationReason(ctx)).toBeUndefined();
    }
    // The deny cell: a denying inner stays deny, with no side-channel write.
    const denyInner: ApprovalPolicy = { evaluate: () => "deny" };
    const denyWrapped = judgePolicy(denyInner, {});
    for (const descriptor of [readDesc, actDesc, criticalDesc]) {
      const ctx = { ...ctxFor(descriptor), threadId: "th-1" };
      expect(await denyWrapped.evaluate(ctx)).toBe("deny");
      expect(getEscalationReason(ctx)).toBeUndefined();
    }
  });

  it("INVARIANT (review follow-up): an engine-source (control-plane) tool is exempt from the judge, even with a model configured", async () => {
    const approveInner: ApprovalPolicy = { evaluate: () => "approve" };
    const policy = judgePolicy(approveInner, {
      model: judgeReturning("escalate: whatever"),
    });
    const ctx = { ...ctxFor(engineActDesc), threadId: "th-1" };
    expect(await policy.evaluate(ctx)).toBe("approve"); // inner's own decision, untouched
    expect(getEscalationReason(ctx)).toBeUndefined();
  });

  it("INVARIANT (review follow-up): judge-policy's escalate-ON-ERROR forced approvals never trip cautionBreaker, however many", async () => {
    const state = createBreakerState();
    const grantStore = createInMemoryGrantStore();
    await seedToolGrant(grantStore, actDesc); // grantPolicy loosens this call to "allow"
    const flakyJudge = judgePolicy(
      grantPolicy(annotationPolicy(), grantStore, { principalScope: () => scope }),
      { model: judgeReturning("uh, sure I guess?") }, // unparseable -> escalate-on-error
    );
    const withCaution = cautionBreaker(flakyJudge, state, { consecutiveThreshold: 3, totalThreshold: 8 });
    for (let i = 0; i < 12; i++) {
      const ctx = {
        ...ctxFor(actDesc),
        threadId: "th-1",
        toolCallId: `call-${i}`,
        provenance: { taintedSources: ["some_tool"] }, // forces escalate-on-error to fire
      };
      // Forced to "approve" by the ERROR path itself, not by caution.
      expect(await withCaution.evaluate(ctx)).toBe("approve");
      await withCaution.onExecuted!(ctx, "approve");
    }
    // Well past both thresholds in call volume, but every stamp was source
    // "error" (a flaky/unparseable judge), never "verdict" — caution must
    // still be inactive.
    const probeCtx = { ...ctxFor(actDesc), threadId: "th-1" };
    expect(await withCaution.evaluate(probeCtx)).toBe("allow");
  });

  it("INVARIANT (review follow-up): an active caution never blocks an engine-source (control-plane) act-tier call", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const escalating: ApprovalPolicy = {
        evaluate: (ctx) => {
          setEscalationReason(ctx, "x", "verdict");
          return "approve";
        },
      };
      const wrapped = cautionBreaker(escalating, state, { consecutiveThreshold: 3 });
      const ctx = { ...ctxFor(actDesc), threadId: "th-1", toolCallId: `e-${i}` };
      await wrapped.evaluate(ctx);
      await wrapped.onExecuted!(ctx, "approve");
    }
    const allowInner: ApprovalPolicy = { evaluate: () => "allow" };
    const policy = cautionBreaker(allowInner, state);
    const ctx = { ...ctxFor(engineActDesc), threadId: "th-1" };
    expect(await policy.evaluate(ctx)).toBe("allow"); // engine-source: never gated, even while caution is active
  });
});

/** `handleConsent` deps around a single pending approval for `descriptor`,
 *  with a live FadeTracker — the full production fade-gating path, not a
 *  tracker-level unit (the §7 contract lives at the consent boundary). */
function fadeConsentDeps(descriptor: ToolDescriptor, input: unknown) {
  const messages = [
    {
      id: "m1",
      role: "assistant",
      parts: [
        { type: `tool-${descriptor.name}`, toolCallId: "call-1", state: "approval-requested", input },
      ],
    },
  ] as unknown as FlowletUIMessage[];
  return {
    grants: createInMemoryGrantStore(),
    audit: new InMemoryAuditLog(),
    fadeTracker: createFadeTracker(),
    resolveDescriptor: (name: string) => (name === descriptor.name ? descriptor : undefined),
    getMessages: async () => messages,
  };
}

describe("ENG-193 §7 — fade invariants (item 5)", () => {
  it("INVARIANT: fade is never offered for a critical tool, no matter how many yeses", async () => {
    const d = fadeConsentDeps(criticalDesc, { to: "a@acme.co" });
    for (let i = 0; i < 5; i++) {
      const result = await handleConsent(d, scope, {
        threadId: "th-1", toolCallId: "call-1", toolName: criticalDesc.name,
        response: { id: "call-1", decision: "yes" },
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.fadeEligible).toBeUndefined();
    }
  });

  it("INVARIANT: fade is never offered for an unverified tool", async () => {
    // No informative hints at all -> act tier but isUnverified === true.
    const unverifiedDesc: ToolDescriptor = {
      name: "mystery_tool", source: "caller", annotations: {}, hasExecute: true, kind: "function",
    };
    const d = fadeConsentDeps(unverifiedDesc, { to: "a@acme.co" });
    for (let i = 0; i < 5; i++) {
      const result = await handleConsent(d, scope, {
        threadId: "th-1", toolCallId: "call-1", toolName: unverifiedDesc.name,
        response: { id: "call-1", decision: "yes" },
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.fadeEligible).toBeUndefined();
    }
  });

  it("INVARIANT: accept mints a grant matching ONLY the derived shape (never tool-wide unless the shape itself was tool-wide)", async () => {
    const resolveDescriptor = (n: string) => (n === actDesc.name ? actDesc : undefined);

    // Constrained shape -> a ONE-constraint constrained scope, never wider.
    const tracker = createFadeTracker();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) {
      tracker.record(scope, actDesc.name, { to }, "yes");
    }
    const offer = tracker.propose(scope, actDesc.name, { to: "d@acme.co" });
    expect(offer).not.toBeNull();
    const grants = createInMemoryGrantStore();
    const result = await handleFadeProposal(
      { fadeTracker: tracker, grants, audit: new InMemoryAuditLog(), resolveDescriptor },
      scope,
      { proposalId: offer!.proposalId, accept: true },
    );
    expect(result.ok).toBe(true);
    const [grant] = await grants.findForTool(scope, actDesc.name);
    expect(grant?.scope).toEqual({
      kind: "constrained",
      constraints: [{ path: "to", op: "matches", value: "*@acme.co" }],
    });
    expect(grant?.source).toEqual({ kind: "fade" });

    // Tool-wide ONLY when the derived shape itself was tool-wide.
    const tracker2 = createFadeTracker();
    for (let i = 0; i < 3; i++) tracker2.record(scope, actDesc.name, { amount: i }, "yes");
    const offer2 = tracker2.propose(scope, actDesc.name, { amount: 9 });
    expect(offer2?.shape).toEqual({ kind: "tool" });
    const grants2 = createInMemoryGrantStore();
    const result2 = await handleFadeProposal(
      { fadeTracker: tracker2, grants: grants2, audit: new InMemoryAuditLog(), resolveDescriptor },
      scope,
      { proposalId: offer2!.proposalId, accept: true },
    );
    expect(result2.ok).toBe(true);
    const [grant2] = await grants2.findForTool(scope, actDesc.name);
    expect(grant2?.scope).toEqual({ kind: "tool" });
  });

  it("INVARIANT: server re-derivation rejects a forged accept for an ineligible/unknown proposalId", async () => {
    const grants = createInMemoryGrantStore();
    const result = await handleFadeProposal(
      {
        fadeTracker: createFadeTracker(), grants, audit: new InMemoryAuditLog(),
        resolveDescriptor: (n: string) => (n === actDesc.name ? actDesc : undefined),
      },
      scope,
      { proposalId: "forged-proposal-id", accept: true },
    );
    expect(result.ok).toBe(false);
    expect(await grants.list(scope)).toHaveLength(0);
  });

  it("INVARIANT: revoke takes effect on the very next call (no caching)", async () => {
    const store = createInMemoryGrantStore();
    const mgr = createGrantManager({ store, audit: new InMemoryAuditLog() });
    const grant = await mgr.create(
      scope,
      { tool: actDesc.name, scope: { kind: "tool" }, duration: "standing", source: { kind: "fade" } },
      actDesc,
    );
    const policy = grantPolicy(annotationPolicy(), store, { principalScope: () => scope });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
    await mgr.revoke(scope, grant.id);
    // grant-policy consults the live store on EVERY evaluate — this pins that
    // contract so a future caching layer can't quietly break revocation.
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("approve");
  });
});

/** Minimal SteeringToolsConfig for the invariant checks below — a fresh
 *  rule/grant store + audit log per test, matching steering-tools.test.ts's
 *  own harness. */
function steeringHarness(resolveDescriptor: (name: string) => ToolDescriptor | undefined) {
  return createSteeringTools({
    principal: scope,
    rules: createInMemoryCompiledRuleStore(),
    grants: createInMemoryGrantStore(),
    audit: new InMemoryAuditLog(),
    resolveDescriptor,
  });
}

describe("ENG-193 §8/item-6 — steering invariants", () => {
  it("INVARIANT: an always_ask rule beats an allowing sibling (grant/judge/breaker) unconditionally", async () => {
    const store = createInMemoryCompiledRuleStore();
    await store.create(scope, { kind: "always_ask", toolPattern: actDesc.name, plainText: "p" });
    const alwaysAllow: ApprovalPolicy = { evaluate: () => "allow" };
    const composed = composePolicy(alwaysAllow, compiledRulesPolicy(store, { principalScope: () => scope }));
    expect(await composed.evaluate(ctxFor(actDesc))).toBe("approve");
  });

  it("INVARIANT: an always_ask rule never escalates a read-tier tool, however broad its glob", async () => {
    const store = createInMemoryCompiledRuleStore();
    await store.create(scope, { kind: "always_ask", toolPattern: "*", plainText: "p" });
    const policy = compiledRulesPolicy(store, { principalScope: () => scope });
    expect(await policy.evaluate(ctxFor(readDesc))).toBe("allow");
  });

  it("INVARIANT: stop_asking_about's own descriptor is critical tier", () => {
    const tools = steeringHarness(() => undefined);
    const descriptor = buildDescriptor("stop_asking_about", tools["stop_asking_about"], "engine");
    expect(dangerTier(descriptor)).toBe("critical");
  });

  it("INVARIANT: always_ask_before's own descriptor is act tier, not unverified", () => {
    const tools = steeringHarness(() => undefined);
    const descriptor = buildDescriptor("always_ask_before", tools["always_ask_before"], "engine");
    expect(dangerTier(descriptor)).toBe("act");
    expect(isUnverified(descriptor)).toBe(false);
  });

  it("INVARIANT: stop_asking_about refuses to mint a grant for a critical target, by construction", async () => {
    const grants = createInMemoryGrantStore();
    const tools = createSteeringTools({
      principal: scope,
      rules: createInMemoryCompiledRuleStore(),
      grants,
      audit: new InMemoryAuditLog(),
      resolveDescriptor: (n) => (n === criticalDesc.name ? criticalDesc : undefined),
    });
    const result = await tools["stop_asking_about"]!.execute!(
      { toolName: criticalDesc.name, plainText: "transferring money" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: false });
    expect(await grants.findForTool(scope, criticalDesc.name)).toHaveLength(0);
  });

  it("INVARIANT: stop_asking_about refuses to mint a grant for an unverified target", async () => {
    const unverifiedDesc: ToolDescriptor = {
      name: "mystery_tool", source: "caller", annotations: {}, hasExecute: true, kind: "function",
    };
    const grants = createInMemoryGrantStore();
    const tools = createSteeringTools({
      principal: scope,
      rules: createInMemoryCompiledRuleStore(),
      grants,
      audit: new InMemoryAuditLog(),
      resolveDescriptor: (n) => (n === unverifiedDesc.name ? unverifiedDesc : undefined),
    });
    const result = await tools["stop_asking_about"]!.execute!(
      { toolName: unverifiedDesc.name, plainText: "using the mystery tool" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: false });
    expect(await grants.findForTool(scope, unverifiedDesc.name)).toHaveLength(0);
  });

  it("INVARIANT: rules are principal-scoped — one principal's rules never leak into another's match", async () => {
    const principalA: Principal = { tenantId: "t", subject: "a" };
    const principalB: Principal = { tenantId: "t", subject: "b" };
    const store = createInMemoryCompiledRuleStore();
    await store.create(principalA, { kind: "always_ask", toolPattern: actDesc.name, plainText: "p" });
    expect(await store.list(principalB)).toHaveLength(0);

    const policy = compiledRulesPolicy(store, { principalScope: () => principalB });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
  });
});
