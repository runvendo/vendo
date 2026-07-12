import { VENDO_POLICY_FORMAT, VendoError } from "@vendoai/core";
import type { Guard, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard, policyFileSchema, policyRuleSchema } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

describe("public guard surface", () => {
  const postureCases: Array<
    [Omit<Parameters<typeof createGuard>[0], "store">, ReturnType<typeof createGuard>["status"] extends () => { posture: infer P } ? P : never]
  > = [
    [{}, "unconfigured"],
    [{ policy: { rules: [] } }, "rules"],
    [{ judge: { decide: async () => ({ action: "run" as const, rationale: "ok" }) } }, "judge"],
    [
      {
        policy: { directions: [] },
        judge: { decide: async () => ({ action: "run" as const, rationale: "ok" }) },
      },
      "rules+judge",
    ],
  ];

  it.each(postureCases)("reports the configured posture %#", (config, posture) => {
    const guard = createGuard({ store: createMemoryStore(), ...config });
    expect(guard.status()).toEqual({ posture });
  });

  it("is assignable to core Guard and passes descriptors through", async () => {
    const tools = new FixtureTools();
    const guard: Guard = createGuard({ store: createMemoryStore() });
    const bound = (guard as ReturnType<typeof createGuard>).bind(tools);
    await expect(bound.descriptors()).resolves.toBe(tools.available);
  });

  it("returns and audits not-found for an unknown tool", async () => {
    const guard = createGuard({ store: createMemoryStore() });
    const result = await guard.bind(new FixtureTools()).execute(call("host_missing"), context());
    expect(result).toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
    const { events } = await guard.audit.query({ principal: alice });
    expect(events).toEqual([
      expect.objectContaining({ kind: "tool-call", tool: "host_missing", outcome: "error" }),
    ]);
  });

  it("normalizes execution throws and preserves VendoError codes", async () => {
    const descriptorValue = descriptor("read");
    const registry = (error: Error): ToolRegistry => ({
      descriptors: async () => [descriptorValue],
      execute: async () => {
        throw error;
      },
    });
    const generic = createGuard({ store: createMemoryStore() }).bind(registry(new Error("boom")));
    await expect(generic.execute(call(descriptorValue.name), context())).resolves.toEqual({
      status: "error",
      error: { code: "error", message: "boom" },
    });
    const vendo = createGuard({ store: createMemoryStore() }).bind(
      registry(new VendoError("conflict", "already done")),
    );
    await expect(vendo.execute(call(descriptorValue.name), context())).resolves.toEqual({
      status: "error",
      error: { code: "conflict", message: "already done" },
    });
  });

  it("lists grant history newest-first and revoke is idempotent and lapses authority", async () => {
    const store = createMemoryStore();
    const write = descriptor("write");
    const first = await seedGrant(store, { descriptor: write, id: "grt_first" });
    const second = await seedGrant(store, { descriptor: write, id: "grt_second" });
    await seedGrant(store, { descriptor: write, id: "grt_bob", subject: "user_bob" });
    const guard = createGuard({
      store,
      policy: { rules: [{ match: { tool: write.name }, action: "ask" }] },
    });

    await expect(guard.grants.list(alice)).resolves.toEqual([second, first]);
    await expect(guard.check(call(write.name), write, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "grant",
    });
    await guard.grants.revoke(second.id, alice);
    await guard.grants.revoke(second.id, alice);
    await guard.grants.revoke(first.id, alice);
    await expect(guard.check(call(write.name, {}, "after_revoke"), write, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });
    const history = await guard.grants.list(alice);
    expect(history).toHaveLength(2);
    expect(history.every((grant) => grant.revokedAt !== undefined)).toBe(true);
    const { events } = await guard.audit.query({ principal: alice, kind: "approval" });
    expect(events.some((event) => JSON.stringify(event.detail ?? {}).includes("grantRevoked"))).toBe(true);
  });

  it("rejects cross-subject grant revocation as not-found", async () => {
    const store = createMemoryStore();
    const grant = await seedGrant(store, { descriptor: descriptor("read") });
    const guard = createGuard({ store });
    await expect(
      guard.grants.revoke(grant.id, { kind: "user", subject: "user_other" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("shows real inputs and truncates approval previews to 500 characters", async () => {
    const critical = descriptor("destructive", { name: "host_critical", critical: true });
    const guard = createGuard({ store: createMemoryStore() });
    const decision = await guard.check(call(critical.name, { secret: "x".repeat(600) }), critical, context());
    expect(decision.action).toBe("ask");
    if (decision.action !== "ask") throw new Error("expected approval");
    expect(decision.approval.inputPreview).toHaveLength(500);
    expect(decision.approval.inputPreview).toContain("secret");
    expect(decision.approval.inputPreview.endsWith("…")).toBe(true);
  });

  it("exports schemas for the persisted policy document", () => {
    expect(
      policyFileSchema.parse({
        format: VENDO_POLICY_FORMAT,
        directions: ["Be careful."],
        rules: [{ match: { tool: "host_*" }, action: "ask" }],
      }),
    ).toMatchObject({ format: VENDO_POLICY_FORMAT });
    expect(policyRuleSchema.safeParse({ match: { risk: "unknown" }, action: "run" }).success).toBe(false);
  });
});
