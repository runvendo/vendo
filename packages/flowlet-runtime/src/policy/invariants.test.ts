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
import { dangerTier } from "./tier";
import type { PolicyContext } from "./types";
import { judgePolicy } from "./judge-policy";
import { cautionBreaker, createBreakerState, volumeBreaker } from "./breakers";
import { getEscalationReason, setEscalationReason } from "./escalation";
import type { ApprovalPolicy } from "./types";

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
});
