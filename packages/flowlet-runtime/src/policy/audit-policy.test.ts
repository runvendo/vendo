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
});
