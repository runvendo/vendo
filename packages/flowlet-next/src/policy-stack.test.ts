import { describe, expect, it } from "vitest";
import { composeProductionPolicy } from "./policy-stack";
import {
  createInMemoryGrantStore,
  InMemoryAuditLog,
  hashDescriptor,
  type ApprovalPolicy,
  type PolicyContext,
  type ToolDescriptor,
} from "@flowlet/runtime";

const scope = { tenantId: "flowlet-embedded", subject: "u1" };
const actDesc: ToolDescriptor = {
  name: "GMAIL_SEND_EMAIL", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};
const fixed = (d: "allow" | "approve" | "deny"): ApprovalPolicy => ({ evaluate: () => d });
const ctxFor = (descriptor: ToolDescriptor): PolicyContext => ({
  toolName: descriptor.name, input: {}, descriptor,
  principal: { userId: "u1" },
});

describe("composeProductionPolicy", () => {
  it("a matching grant suppresses a repeat approve on the base layer", async () => {
    const grants = createInMemoryGrantStore();
    await grants.create(scope, {
      tool: actDesc.name, descriptorHash: hashDescriptor(actDesc),
      scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" },
    });
    const policy = composeProductionPolicy(fixed("approve"), {
      grants, audit: new InMemoryAuditLog(),
    });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("allow");
  });

  it("INVARIANT: never suppresses critical, even with a matching grant", async () => {
    const grants = createInMemoryGrantStore();
    await grants.create(scope, {
      tool: criticalDesc.name, descriptorHash: hashDescriptor(criticalDesc),
      scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" },
    });
    const policy = composeProductionPolicy(fixed("approve"), {
      grants, audit: new InMemoryAuditLog(),
    });
    expect(await policy.evaluate(ctxFor(criticalDesc))).toBe("approve");
  });

  it("audit layer records tool_execution on onExecuted", async () => {
    const audit = new InMemoryAuditLog();
    const policy = composeProductionPolicy(fixed("allow"), {
      grants: createInMemoryGrantStore(), audit, now: () => "2026-07-04T00:00:00Z",
    });
    await policy.onExecuted!({ ...ctxFor(actDesc), toolCallId: "call-1" }, "allow");
    expect(await audit.query(scope, { kinds: ["tool_execution"] })).toHaveLength(1);
  });
});
