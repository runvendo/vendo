import { describe, expect, it } from "vitest";
import { auditPolicy } from "./audit-policy";
import { InMemoryAuditLog } from "../embedded/in-memory-store";
import { setEscalationReason } from "./escalation";
import type { PolicyContext } from "./types";
import type { ToolDescriptor } from "../descriptor";

const scope = { tenantId: "t", subject: "u" };
const desc: ToolDescriptor = { name: "send_email", source: "caller", annotations: { readOnlyHint: false, destructiveHint: false }, hasExecute: true, kind: "function" };
const ctx: PolicyContext = {
  toolName: "send_email", input: {}, descriptor: desc, toolCallId: "call-1",
  principal: { userId: "u" } as never,
};

describe("auditPolicy", () => {
  it("contributes allow and records tool_execution on onExecuted", async () => {
    const audit = new InMemoryAuditLog();
    const p = auditPolicy(audit, { principalScope: () => scope, now: () => "2026-07-04T00:00:00Z" });
    expect(await p.evaluate(ctx)).toBe("allow");
    await p.onExecuted!(ctx, "approve");
    const rows = await audit.query(scope, { kinds: ["tool_execution"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "tool_execution", toolName: "send_email", toolCallId: "call-1",
      mutating: true, dangerous: false, outcome: "ok",
    });
  });

  it("also records a judge_escalation event when the ctx carries a stamped reason", async () => {
    const audit = new InMemoryAuditLog();
    const p = auditPolicy(audit, { principalScope: () => scope, now: () => "2026-07-04T00:00:00Z" });
    const escalatedCtx: PolicyContext = { ...ctx };
    setEscalationReason(escalatedCtx, "an email I read asked for this");
    await p.onExecuted!(escalatedCtx, "approve");
    const rows = await audit.query(scope, {});
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "judge_escalation", toolName: "send_email", reason: "an email I read asked for this",
      }),
    );
  });

  it("records only tool_execution when the ctx carries no escalation reason", async () => {
    const audit = new InMemoryAuditLog();
    const p = auditPolicy(audit, { principalScope: () => scope, now: () => "2026-07-04T00:00:00Z" });
    await p.onExecuted!({ ...ctx }, "allow");
    const rows = await audit.query(scope, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tool_execution" });
  });

  it("an escalated call that is NEVER executed (user declined) still yields exactly one judge_escalation", async () => {
    // Production shape: the judge/breaker chain evaluates FIRST (stamping the
    // reason on ctx), the audit sibling LAST — see composeProductionPolicy's
    // composition contract. A declined call is evaluated once (needsApproval)
    // and never reaches execute/onExecuted.
    const audit = new InMemoryAuditLog();
    const p = auditPolicy(audit, { principalScope: () => scope, now: () => "2026-07-04T00:00:00Z" });
    const declinedCtx: PolicyContext = { ...ctx, toolCallId: "call-declined" };
    setEscalationReason(declinedCtx, "suspicious");
    expect(await p.evaluate(declinedCtx)).toBe("allow");
    const rows = await audit.query(scope, { kinds: ["judge_escalation"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "judge_escalation", toolName: "send_email", reason: "suspicious" });
  });

  it("dedupes per toolCallId: the double-evaluate AND the execute path yield ONE judge_escalation total", async () => {
    const audit = new InMemoryAuditLog();
    const p = auditPolicy(audit, { principalScope: () => scope, now: () => "2026-07-04T00:00:00Z" });
    // needsApproval-time evaluate (ctx A, reason stamped by the chain)...
    const ctxA: PolicyContext = { ...ctx, toolCallId: "call-2" };
    setEscalationReason(ctxA, "suspicious");
    await p.evaluate(ctxA);
    // ...execute-time evaluate (SEPARATE ctx B, same toolCallId, memo re-stamps)...
    const ctxB: PolicyContext = { ...ctx, toolCallId: "call-2" };
    setEscalationReason(ctxB, "suspicious");
    await p.evaluate(ctxB);
    // ...and the genuine execute's onExecuted.
    await p.onExecuted!(ctxB, "approve");
    const escalations = await audit.query(scope, { kinds: ["judge_escalation"] });
    expect(escalations).toHaveLength(1);
    // tool_execution is still recorded once, independent of the dedupe.
    expect(await audit.query(scope, { kinds: ["tool_execution"] })).toHaveLength(1);
  });

  it("a DIFFERENT toolCallId's escalation is a separate event (dedupe is per call, not per tool)", async () => {
    const audit = new InMemoryAuditLog();
    const p = auditPolicy(audit, { principalScope: () => scope, now: () => "2026-07-04T00:00:00Z" });
    for (const id of ["call-3", "call-4"]) {
      const c: PolicyContext = { ...ctx, toolCallId: id };
      setEscalationReason(c, "suspicious");
      await p.evaluate(c);
    }
    expect(await audit.query(scope, { kinds: ["judge_escalation"] })).toHaveLength(2);
  });
});
