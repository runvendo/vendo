import { describe, expect, it } from "vitest";
import { createSteeringTools } from "./steering-tools";
import { createInMemoryCompiledRuleStore } from "./rule-store";
import { createInMemoryGrantStore } from "./grant-store";
import { InMemoryAuditLog } from "./embedded/in-memory-store";
import { buildDescriptor } from "./descriptor";
import { dangerTier } from "./policy";
import type { ToolDescriptor } from "./descriptor";

const principal = { tenantId: "t", subject: "u" };
const actDescriptor: ToolDescriptor = {
  name: "sendClientMessage", source: "caller",
  annotations: { readOnlyHint: false, destructiveHint: false }, hasExecute: true, kind: "function",
};
const criticalDescriptor: ToolDescriptor = {
  name: "transfer_money", source: "caller",
  annotations: { destructiveHint: true }, hasExecute: true, kind: "function",
};
const unverifiedDescriptor: ToolDescriptor = {
  name: "mystery_tool", source: "composio", annotations: {}, hasExecute: true, kind: "function",
};

function harness(resolveDescriptor: (name: string) => ToolDescriptor | undefined) {
  const rules = createInMemoryCompiledRuleStore();
  const grants = createInMemoryGrantStore();
  const audit = new InMemoryAuditLog();
  const tools = createSteeringTools({ principal, rules, grants, audit, resolveDescriptor, now: () => "2026-07-04T00:00:00Z" });
  return { tools, rules, grants, audit };
}

describe("createSteeringTools", () => {
  it("both tools' own descriptors land on the right tier", () => {
    const { tools } = harness(() => undefined);
    expect(dangerTier(buildDescriptor("always_ask_before", tools["always_ask_before"], "engine"))).toBe("act");
    expect(dangerTier(buildDescriptor("stop_asking_about", tools["stop_asking_about"], "engine"))).toBe("critical");
  });

  it("always_ask_before creates a rule and returns a voice-back confirmation", async () => {
    const { tools, rules } = harness(() => undefined);
    const result = await tools["always_ask_before"]!.execute!(
      { toolPattern: "sendClientMessage", plainText: "emailing anyone at Acme" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: true, confirmation: expect.stringContaining("Got it") });
    expect(await rules.list(principal)).toHaveLength(1);
  });

  it("stop_asking_about mints a standing grant with source compiled-rule", async () => {
    const { tools, grants } = harness((n) => (n === "sendClientMessage" ? actDescriptor : undefined));
    const result = await tools["stop_asking_about"]!.execute!(
      { toolName: "sendClientMessage", plainText: "sending client messages" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: true, confirmation: expect.stringContaining("Done") });
    const [grant] = await grants.findForTool(principal, "sendClientMessage");
    expect(grant?.source).toEqual({ kind: "compiled-rule", rule: "sending client messages" });
    expect(grant?.scope).toEqual({ kind: "tool" });
  });

  it("stop_asking_about with a constraint mints a narrowed grant", async () => {
    const { tools, grants } = harness(() => actDescriptor);
    await tools["stop_asking_about"]!.execute!(
      {
        toolName: "sendClientMessage",
        constraint: { path: "clientId", op: "eq", value: "acme" },
        plainText: "messaging Acme",
      },
      { toolCallId: "c1", messages: [] } as never,
    );
    const [grant] = await grants.findForTool(principal, "sendClientMessage");
    expect(grant?.scope).toEqual({
      kind: "constrained", constraints: [{ path: "clientId", op: "eq", value: "acme" }],
    });
  });

  it("INVARIANT: refuses to loosen a critical target", async () => {
    const { tools, grants } = harness(() => criticalDescriptor);
    const result = await tools["stop_asking_about"]!.execute!(
      { toolName: "transfer_money", plainText: "transferring money" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: false });
    expect(await grants.findForTool(principal, "transfer_money")).toHaveLength(0);
  });

  it("INVARIANT: refuses to loosen an unverified target", async () => {
    const { tools, grants } = harness(() => unverifiedDescriptor);
    const result = await tools["stop_asking_about"]!.execute!(
      { toolName: "mystery_tool", plainText: "using the mystery tool" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: false });
    expect(await grants.findForTool(principal, "mystery_tool")).toHaveLength(0);
  });

  it("errors cleanly on an unknown target tool", async () => {
    const { tools } = harness(() => undefined);
    const result = await tools["stop_asking_about"]!.execute!(
      { toolName: "no_such_tool", plainText: "x" },
      { toolCallId: "c1", messages: [] } as never,
    );
    expect(result).toMatchObject({ ok: false });
  });
});
