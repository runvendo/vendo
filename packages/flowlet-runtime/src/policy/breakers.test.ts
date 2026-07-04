import { describe, it, expect } from "vitest";
import { createBreakerState, cautionBreaker, volumeBreaker } from "./breakers";
import { getEscalationReason, setEscalationReason } from "./escalation";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import type { ToolDescriptor } from "../descriptor";

const actDesc: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};

function fixed(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => decision };
}

/** A stub that reports "escalate" (stamps a reason) on evaluate, mimicking judgePolicy's output. */
function escalatingStub(decision: ApprovalDecision = "approve"): ApprovalPolicy {
  return {
    evaluate(ctx) {
      if (decision === "approve") setEscalationReason(ctx, "judge escalation");
      return decision;
    },
  };
}

function ctxFor(descriptor: ToolDescriptor, threadId = "th-1"): PolicyContext {
  return { toolName: descriptor.name, input: {}, descriptor, principal: { userId: "u" }, threadId };
}

describe("volumeBreaker", () => {
  it("passes decisions through below the threshold", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 3 });
    for (let i = 0; i < 2; i++) {
      const ctx = ctxFor(actDesc);
      expect(await policy.evaluate(ctx)).toBe("allow");
      await policy.onExecuted!(ctx, "allow");
    }
  });

  it("forces approve once the per-thread per-tool executed count hits the threshold, with a reason", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 3 });
    for (let i = 0; i < 3; i++) {
      const ctx = ctxFor(actDesc);
      await policy.evaluate(ctx);
      await policy.onExecuted!(ctx, "allow");
    }
    const ctx4 = ctxFor(actDesc);
    expect(await policy.evaluate(ctx4)).toBe("approve");
    expect(getEscalationReason(ctx4)).toMatch(/volume/);
  });

  it("counts are isolated per thread and per tool", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 2 });
    for (let i = 0; i < 2; i++) {
      const ctx = ctxFor(actDesc, "th-A");
      await policy.evaluate(ctx);
      await policy.onExecuted!(ctx, "allow");
    }
    // A different thread's tally starts fresh.
    expect(await policy.evaluate(ctxFor(actDesc, "th-B"))).toBe("allow");
    // A different tool's tally on the SAME thread starts fresh too.
    const otherToolDesc: ToolDescriptor = { ...actDesc, name: "GMAIL_LIST" };
    expect(await policy.evaluate(ctxFor(otherToolDesc, "th-A"))).toBe("allow");
  });

  it("INVARIANT: never touches deny or critical", async () => {
    const state = createBreakerState();
    expect(await volumeBreaker(fixed("deny"), state, { threshold: 1 }).evaluate(ctxFor(actDesc))).toBe("deny");
    const criticalPolicy = volumeBreaker(fixed("approve"), state, { threshold: 1 });
    for (let i = 0; i < 5; i++) {
      const ctx = ctxFor(criticalDesc);
      expect(await criticalPolicy.evaluate(ctx)).toBe("approve"); // untouched either way
    }
  });

  it("never touches an already-'approve' decision (nothing to force)", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("approve"), state, { threshold: 1 });
    const ctx = ctxFor(actDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
    expect(getEscalationReason(ctx)).toBeUndefined();
  });

  it("skips automation contexts (no threadId)", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 1 });
    const ctx = { toolName: actDesc.name, input: {}, descriptor: actDesc, principal: { userId: "u" } };
    await policy.onExecuted!(ctx, "allow"); // even after "many" executes...
    await policy.onExecuted!(ctx, "allow");
    expect(await policy.evaluate(ctx)).toBe("allow"); // ...still untouched, no threadId
  });
});

describe("cautionBreaker", () => {
  it("3 consecutive judge escalations trip caution: the NEXT act-tier 'allow' is forced to approve", async () => {
    const state = createBreakerState();
    const policy = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      const ctx = ctxFor(actDesc);
      expect(await policy.evaluate(ctx)).toBe("approve"); // the judge's own escalation
      await policy.onExecuted!(ctx, "approve"); // the user says yes anyway — still "flagged", not clean
    }
    const nextInner = escalatingStub("allow"); // a LATER call the judge is fine with
    const laterPolicy = cautionBreaker(nextInner, state, { consecutiveThreshold: 3 });
    const ctx4 = ctxFor(actDesc);
    expect(await laterPolicy.evaluate(ctx4)).toBe("approve");
    expect(getEscalationReason(ctx4)).toBeTruthy();
  });

  it("8 total (non-consecutive) judge escalations also trip caution", async () => {
    const state = createBreakerState();
    // Interleave escalations with clean approvals so it's never 3 in a row,
    // but the TOTAL still crosses 8.
    for (let i = 0; i < 8; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 99, totalThreshold: 8 });
      const ctx = ctxFor(actDesc);
      await esc.evaluate(ctx);
      await esc.onExecuted!(ctx, "approve");
      const clean = cautionBreaker(fixed("approve"), state, { consecutiveThreshold: 99, totalThreshold: 8 });
      const cleanCtx = ctxFor(actDesc);
      await clean.evaluate(cleanCtx);
      await clean.onExecuted!(cleanCtx, "approve");
    }
    const policy = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 99, totalThreshold: 8 });
    const ctx = ctxFor(actDesc);
    expect(await policy.evaluate(ctx)).toBe("approve");
  });

  it("does NOT flag read-tier calls even while caution is active", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      const ctx = ctxFor(actDesc);
      await esc.evaluate(ctx);
      await esc.onExecuted!(ctx, "approve");
    }
    const readDesc: ToolDescriptor = { name: "get_x", source: "caller", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function" };
    const policy = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 });
    expect(await policy.evaluate(ctxFor(readDesc))).toBe("allow");
  });

  it("INVARIANT: caution state cannot suppress critical's ceremony (untouched either way)", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      const ctx = ctxFor(actDesc);
      await esc.evaluate(ctx);
      await esc.onExecuted!(ctx, "approve");
    }
    const policy = cautionBreaker(fixed("approve"), state, { consecutiveThreshold: 3 });
    expect(await policy.evaluate(ctxFor(criticalDesc))).toBe("approve"); // was already approve — critical, untouched
  });

  it("5 clean human approvals lift caution", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3, cleanApprovalsToLift: 5 });
      const ctx = ctxFor(actDesc);
      await esc.evaluate(ctx);
      await esc.onExecuted!(ctx, "approve");
    }
    // Caution is active: confirm it's forcing.
    const check = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3, cleanApprovalsToLift: 5 });
    expect(await check.evaluate(ctxFor(actDesc))).toBe("approve");

    // 5 clean approvals (inner NOT escalating) lift it.
    for (let i = 0; i < 5; i++) {
      const clean = cautionBreaker(fixed("approve"), state, { consecutiveThreshold: 3, cleanApprovalsToLift: 5 });
      const ctx = ctxFor(actDesc);
      await clean.evaluate(ctx);
      await clean.onExecuted!(ctx, "approve");
    }
    const after = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3, cleanApprovalsToLift: 5 });
    expect(await after.evaluate(ctxFor(actDesc))).toBe("allow");
  });

  it("skips automation contexts (no threadId)", async () => {
    const state = createBreakerState();
    const ctx = { toolName: actDesc.name, input: {}, descriptor: actDesc, principal: { userId: "u" } };
    const escalating = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 1 });
    await escalating.evaluate(ctx);
    await escalating.onExecuted!(ctx, "approve");
    const policy = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 1 });
    expect(await policy.evaluate(ctx)).toBe("allow"); // never tripped — no thread to key on
  });
});
