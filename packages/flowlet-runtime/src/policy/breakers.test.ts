import { describe, it, expect } from "vitest";
import { createBreakerState, cautionBreaker, volumeBreaker } from "./breakers";
import { getEscalationReason, getEscalationSource, setEscalationReason } from "./escalation";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import type { ToolDescriptor } from "../descriptor";

const actDesc: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};
const controlActDesc: ToolDescriptor = {
  name: "always_ask_before", source: "control", annotations: { readOnlyHint: false, destructiveHint: false },
  hasExecute: true, kind: "function",
};
/** A host-supplied server tool (source "engine") — NOT control-plane.
 *  ENG-193 PR #40 review (item A): breakers must gate/count this normally;
 *  only source "control" is exempt. */
const hostEngineActDesc: ToolDescriptor = {
  name: "issue_refund", source: "engine", annotations: { readOnlyHint: false, destructiveHint: false },
  hasExecute: true, kind: "function",
};

function fixed(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => decision };
}

/** A stub that reports a REAL judge "escalate" verdict (stamps source
 *  "verdict") on evaluate, mimicking judgePolicy's `applyVerdict` output. */
function escalatingStub(decision: ApprovalDecision = "approve"): ApprovalPolicy {
  return {
    evaluate(ctx) {
      if (decision === "approve") setEscalationReason(ctx, "judge escalation", "verdict");
      return decision;
    },
  };
}

/** A stub that reports judge-policy's own escalate-ON-ERROR bias (stamps
 *  source "error") — model unreliability, NOT a judge verdict (review
 *  follow-up: this must never feed cautionBreaker's counting). */
function errorStub(decision: ApprovalDecision = "approve"): ApprovalPolicy {
  return {
    evaluate(ctx) {
      if (decision === "approve") setEscalationReason(ctx, "judge model error", "error");
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

  it("counts are scoped per principal — the same threadId under a different user starts fresh", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 2 });
    for (let i = 0; i < 2; i++) {
      const ctx = ctxFor(actDesc, "th-A");
      await policy.evaluate(ctx);
      await policy.onExecuted!(ctx, "allow");
    }
    // Tripped for principal "u" on th-A...
    expect(await policy.evaluate(ctxFor(actDesc, "th-A"))).toBe("approve");
    // ...but a DIFFERENT principal on the SAME thread starts fresh.
    const otherUser = { ...ctxFor(actDesc, "th-A"), principal: { userId: "someone-else" } };
    expect(await policy.evaluate(otherUser)).toBe("allow");
  });

  it("REVIEW FOLLOW-UP: never forces a card for read-tier calls, however many — reads just flow", async () => {
    const state = createBreakerState();
    const readDesc: ToolDescriptor = { name: "get_x", source: "caller", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function" };
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 3 });
    for (let i = 0; i < 20; i++) {
      const ctx = ctxFor(readDesc);
      expect(await policy.evaluate(ctx)).toBe("allow");
      await policy.onExecuted!(ctx, "allow");
    }
    expect(await policy.evaluate(ctxFor(readDesc))).toBe("allow"); // never tripped
  });

  it("REVIEW FOLLOW-UP: never forces a card for a source-\"control\" (control-plane) call, however many, and never counts it", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 3 });
    for (let i = 0; i < 20; i++) {
      const ctx = ctxFor(controlActDesc);
      expect(await policy.evaluate(ctx)).toBe("allow");
      await policy.onExecuted!(ctx, "allow");
    }
    expect(await policy.evaluate(ctxFor(controlActDesc))).toBe("allow"); // never tripped
    // An ordinary act-tier tool's OWN tally is untouched by the control-plane
    // calls above (they were never counted at all).
    const ordinaryPolicy = volumeBreaker(fixed("allow"), state, { threshold: 3 });
    for (let i = 0; i < 2; i++) {
      const ctx = ctxFor(actDesc);
      await ordinaryPolicy.evaluate(ctx);
      await ordinaryPolicy.onExecuted!(ctx, "allow");
    }
    expect(await ordinaryPolicy.evaluate(ctxFor(actDesc))).toBe("allow"); // only 2 counted, below threshold 3
  });

  it("REGRESSION (ENG-193 PR #40 review — item A): a host-supplied server tool (source \"engine\") IS counted and forced to approve past the threshold", async () => {
    const state = createBreakerState();
    const policy = volumeBreaker(fixed("allow"), state, { threshold: 3 });
    for (let i = 0; i < 3; i++) {
      const ctx = ctxFor(hostEngineActDesc);
      expect(await policy.evaluate(ctx)).toBe("allow");
      await policy.onExecuted!(ctx, "allow");
    }
    const ctx4 = ctxFor(hostEngineActDesc);
    expect(await policy.evaluate(ctx4)).toBe("approve");
    expect(getEscalationReason(ctx4)).toMatch(/volume/);
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

  it("REGRESSION: the SDK's double-evaluate (same toolCallId at needsApproval + execute) counts ONE escalation, not two", async () => {
    // Production evaluates the composed policy TWICE per call — once from
    // needsApproval, once from execute — with two different ctx objects that
    // share the same toolCallId. Without toolCallId dedupe, each escalated
    // call counted twice and caution tripped at ~half the documented
    // thresholds, dependent on whether the user approved (execute ran).
    const state = createBreakerState();
    // 2 distinct escalated calls, each evaluated TWICE (4 evaluations, 2 escalations).
    for (let i = 0; i < 2; i++) {
      const policy = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      for (let pass = 0; pass < 2; pass++) {
        const ctx = { ...ctxFor(actDesc), toolCallId: `call-${i}` };
        expect(await policy.evaluate(ctx)).toBe("approve");
      }
    }
    // Only 2 DISTINCT escalations so far — caution must NOT be tripped.
    const probe1 = { ...ctxFor(actDesc), toolCallId: "probe-1" };
    expect(await cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 }).evaluate(probe1)).toBe("allow");
    // The THIRD distinct escalated call (also double-evaluated) trips it at exactly 3.
    const third = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
    await third.evaluate({ ...ctxFor(actDesc), toolCallId: "call-2" });
    await third.evaluate({ ...ctxFor(actDesc), toolCallId: "call-2" });
    const probe2 = { ...ctxFor(actDesc), toolCallId: "probe-2" };
    expect(await cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 }).evaluate(probe2)).toBe("approve");
    expect(getEscalationReason(probe2)).toBeTruthy();
  });

  it("REVIEW FOLLOW-UP: error-path (judge escalate-on-error) stamps never trip caution, however many", async () => {
    const state = createBreakerState();
    // Well beyond both thresholds, but every stamp is source "error".
    for (let i = 0; i < 12; i++) {
      const esc = cautionBreaker(errorStub("approve"), state, { consecutiveThreshold: 3, totalThreshold: 8 });
      const ctx = { ...ctxFor(actDesc), toolCallId: `err-${i}` };
      expect(await esc.evaluate(ctx)).toBe("approve"); // errorStub's own approve passes through untouched
      await esc.onExecuted!(ctx, "approve");
    }
    const probe = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3, totalThreshold: 8 });
    const ctx = ctxFor(actDesc);
    expect(await probe.evaluate(ctx)).toBe("allow"); // caution never activated
    expect(getEscalationReason(ctx)).toBeUndefined();
  });

  it("REVIEW FOLLOW-UP: real judge-verdict escalations still trip caution exactly as before (3 consecutive)", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      const ctx = { ...ctxFor(actDesc), toolCallId: `v-${i}` };
      expect(await esc.evaluate(ctx)).toBe("approve");
      await esc.onExecuted!(ctx, "approve");
    }
    const probe = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 });
    const ctx = ctxFor(actDesc);
    expect(await probe.evaluate(ctx)).toBe("approve");
    expect(getEscalationSource(ctx)).toBe("verdict");
  });

  it("REVIEW FOLLOW-UP: an active caution does not block a source-\"control\" (control-plane) act-tier call", async () => {
    const state = createBreakerState();
    // Trip caution with 3 consecutive REAL judge escalations on a non-control tool.
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      const ctx = { ...ctxFor(actDesc), toolCallId: `t-${i}` };
      await esc.evaluate(ctx);
      await esc.onExecuted!(ctx, "approve");
    }
    // Confirm it IS active for the ordinary act-tier tool...
    const ordinary = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 });
    expect(await ordinary.evaluate(ctxFor(actDesc))).toBe("approve");
    // ...but a control-plane tool's "allow" (e.g. always_ask_before) passes straight through.
    const controlCtx = ctxFor(controlActDesc);
    const control = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 });
    expect(await control.evaluate(controlCtx)).toBe("allow");
    expect(getEscalationReason(controlCtx)).toBeUndefined();
  });

  it("REGRESSION (ENG-193 PR #40 review — item A): an active caution DOES gate a host-supplied server tool (source \"engine\")", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      const ctx = { ...ctxFor(actDesc), toolCallId: `h-${i}` };
      await esc.evaluate(ctx);
      await esc.onExecuted!(ctx, "approve");
    }
    const hostCtx = ctxFor(hostEngineActDesc);
    const policy = cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 });
    expect(await policy.evaluate(hostCtx)).toBe("approve");
    expect(getEscalationReason(hostCtx)).toBeTruthy();
  });

  it("caution state is scoped per principal — the same threadId under a different user starts fresh", async () => {
    const state = createBreakerState();
    for (let i = 0; i < 3; i++) {
      const esc = cautionBreaker(escalatingStub("approve"), state, { consecutiveThreshold: 3 });
      await esc.evaluate({ ...ctxFor(actDesc), toolCallId: `c-${i}` });
    }
    // Tripped for principal "u"...
    expect(await cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 }).evaluate(ctxFor(actDesc))).toBe("approve");
    // ...but a DIFFERENT principal on the SAME thread is untouched.
    const otherUser = { ...ctxFor(actDesc), principal: { userId: "someone-else" } };
    expect(await cautionBreaker(fixed("allow"), state, { consecutiveThreshold: 3 }).evaluate(otherUser)).toBe("allow");
  });
});
