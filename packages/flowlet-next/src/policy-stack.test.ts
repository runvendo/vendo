import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { composeProductionPolicy } from "./policy-stack";
import {
  createInMemoryGrantStore,
  InMemoryAuditLog,
  hashDescriptor,
  type ApprovalPolicy,
  type PolicyContext,
  type ToolDescriptor,
} from "@flowlet/runtime";

const ZERO_USAGE: LanguageModelV3GenerateResult["usage"] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
function mockReturning(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage: ZERO_USAGE, warnings: [],
    }),
  });
}

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

describe("composeProductionPolicy — judge + breakers", () => {
  it("with NO judgeModel, behaves EXACTLY like item 2 (identity judge, no breaker forcing at low volume)", async () => {
    const policy = composeProductionPolicy(fixed("approve"), {
      grants: createInMemoryGrantStore(), audit: new InMemoryAuditLog(),
    });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("approve");
  });

  it("with a judgeModel returning match, an act-tier approve downgrades to allow", async () => {
    const policy = composeProductionPolicy(fixed("approve"), {
      grants: createInMemoryGrantStore(), audit: new InMemoryAuditLog(),
      judgeModel: mockReturning("match"),
    });
    expect(await policy.evaluate({ ...ctxFor(actDesc), threadId: "th-1" })).toBe("allow");
  });

  it("with a judgeModel returning escalate, a grant-suppressed allow is forced back to approve", async () => {
    const grants = createInMemoryGrantStore();
    await grants.create(scope, {
      tool: actDesc.name, descriptorHash: hashDescriptor(actDesc),
      scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" },
    });
    const policy = composeProductionPolicy(fixed("approve"), {
      grants, audit: new InMemoryAuditLog(),
      judgeModel: mockReturning("escalate: this looks different from usual"),
    });
    expect(await policy.evaluate({ ...ctxFor(actDesc), threadId: "th-1" })).toBe("approve");
  });

  it("INVARIANT: a matching grant for a critical tool still asks even with a judge configured", async () => {
    const grants = createInMemoryGrantStore();
    await grants.create(scope, {
      tool: criticalDesc.name, descriptorHash: hashDescriptor(criticalDesc),
      scope: { kind: "tool" }, duration: "standing", source: { kind: "chat" },
    });
    const policy = composeProductionPolicy(fixed("approve"), {
      grants, audit: new InMemoryAuditLog(), judgeModel: mockReturning("match"),
    });
    expect(await policy.evaluate({ ...ctxFor(criticalDesc), threadId: "th-1" })).toBe("approve");
  });
});
