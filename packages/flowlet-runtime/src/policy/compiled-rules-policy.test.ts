import { describe, expect, it } from "vitest";
import { compiledRulesPolicy } from "./compiled-rules-policy";
import { composePolicy } from "./compose";
import { createInMemoryCompiledRuleStore } from "../rule-store";
import type { PolicyContext } from "./types";
import type { ToolDescriptor } from "../descriptor";

const scope = { tenantId: "t", subject: "u" };
const actDesc: ToolDescriptor = { name: "send_email", source: "caller", annotations: { readOnlyHint: false, destructiveHint: false }, hasExecute: true, kind: "function" };
const readDesc: ToolDescriptor = { name: "get_email", source: "caller", annotations: { readOnlyHint: true }, hasExecute: true, kind: "function" };
const fixed = (d: "allow" | "approve" | "deny") => ({ evaluate: () => d });
const ctxFor = (descriptor: ToolDescriptor, input: unknown = {}): PolicyContext => ({
  toolName: descriptor.name, input, descriptor,
  principal: { userId: "u" },
});

async function seedRule(store: ReturnType<typeof createInMemoryCompiledRuleStore>, toolPattern: string) {
  await store.create(scope, { kind: "always_ask", toolPattern, plainText: "p" });
}

describe("compiledRulesPolicy", () => {
  it("forces approve for a matching act-tier call, alone", async () => {
    const store = createInMemoryCompiledRuleStore();
    await seedRule(store, "send_email");
    const p = compiledRulesPolicy(store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(actDesc))).toBe("approve");
  });
  it("allows a non-matching call", async () => {
    const store = createInMemoryCompiledRuleStore();
    await seedRule(store, "other_tool");
    const p = compiledRulesPolicy(store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(actDesc))).toBe("allow");
  });
  it("never escalates a read-tier tool (Moment 1 is untouchable), even with a matching glob", async () => {
    const store = createInMemoryCompiledRuleStore();
    await seedRule(store, "*"); // deliberately over-broad
    const p = compiledRulesPolicy(store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(readDesc))).toBe("allow");
  });
  it("a revoked rule no longer matches", async () => {
    const store = createInMemoryCompiledRuleStore();
    const r = await store.create(scope, { kind: "always_ask", toolPattern: "send_email", plainText: "p" });
    await store.revoke(scope, r.id);
    const p = compiledRulesPolicy(store, { principalScope: () => scope });
    expect(await p.evaluate(ctxFor(actDesc))).toBe("allow");
  });
  it("INVARIANT: a rule beats a grant/allow sibling — composePolicy's most-restrictive-wins", async () => {
    const store = createInMemoryCompiledRuleStore();
    await seedRule(store, "send_email");
    const composed = composePolicy(fixed("allow"), compiledRulesPolicy(store, { principalScope: () => scope }));
    expect(await composed.evaluate(ctxFor(actDesc))).toBe("approve");
  });
});
