import { describe, expect, it } from "vitest";
import { grantPolicy } from "./grant-policy";
import { createInMemoryGrantStore } from "../grant-store";
import type { ApprovalPolicy, PolicyContext } from "./types";
import type { ToolDescriptor } from "../descriptor";
import { hashDescriptor } from "../automations/grants";

const scope = { tenantId: "t", subject: "u" };
const actDesc: ToolDescriptor = { name: "send_email", source: "caller", annotations: { readOnlyHint: false }, hasExecute: true, kind: "function" };
const criticalDesc: ToolDescriptor = { name: "transfer_money", source: "caller", annotations: { destructiveHint: true }, hasExecute: true, kind: "function" };
const fixed = (d: "allow" | "approve" | "deny"): ApprovalPolicy => ({ evaluate: () => d });
const ctxFor = (descriptor: ToolDescriptor, input: unknown = {}): PolicyContext => ({
  toolName: descriptor.name, input, descriptor,
  principal: { userId: "u", tenantId: "t", subject: "u" } as never,
});

async function grantFor(store: ReturnType<typeof createInMemoryGrantStore>, descriptor: ToolDescriptor) {
  await store.create(scope, {
    tool: descriptor.name, descriptorHash: hashDescriptor(descriptor),
    scope: { kind: "tool" }, duration: "standing", source: { kind: "fade" },
  });
}

describe("grantPolicy", () => {
  it("suppresses approve→allow for a matching act-tier grant", async () => {
    const store = createInMemoryGrantStore();
    await grantFor(store, actDesc);
    const p = grantPolicy(fixed("approve"), store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(actDesc))).toBe("allow");
  });
  it("INVARIANT: never suppresses a critical tool, even with a matching grant", async () => {
    const store = createInMemoryGrantStore();
    await grantFor(store, criticalDesc);
    const p = grantPolicy(fixed("approve"), store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(criticalDesc))).toBe("approve");
  });
  it("INVARIANT: never overrides deny", async () => {
    const store = createInMemoryGrantStore();
    await grantFor(store, actDesc);
    const p = grantPolicy(fixed("deny"), store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(actDesc))).toBe("deny");
  });
  it("no matching grant → inner decision unchanged", async () => {
    const store = createInMemoryGrantStore();
    const p = grantPolicy(fixed("approve"), store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(actDesc))).toBe("approve");
  });
  it("propagates onExecuted to inner", async () => {
    const calls: string[] = [];
    const inner: ApprovalPolicy = { evaluate: () => "allow", onExecuted: async () => { calls.push("inner"); } };
    const p = grantPolicy(inner, createInMemoryGrantStore(), { principalScope: () => scope });
    await p.onExecuted!(ctxFor(actDesc), "allow");
    expect(calls).toEqual(["inner"]);
  });
});
