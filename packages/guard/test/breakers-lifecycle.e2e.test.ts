import { descriptorHash } from "@vendoai/core";
import type { ToolDescriptor } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, bob, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

// These exercise the priority behaviours end-to-end through the public surface
// (guard.bind / approvals / grants / audit) against the real-SQL PGlite mapping,
// asserting the persisted side effects with raw SQL on the reserved tables. The
// dependency guard forbids @vendoai/guard from importing @vendoai/store even in
// tests, so the store here is the routed PGlite fixture — real Postgres SQL over
// the same reserved-table schema, exposed via `.query()`.

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

describe("grant descriptorHash drift → lapse → re-approval (05 §2 step 2, core §5)", () => {
  it("lapses the minted grant on drift, forces re-approval, and lands both grants in vendo_grants", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      policy: { rules: [{ match: { tool: "host_drift" }, action: "ask" }] },
    });
    // A risk override changes the canonical descriptor fingerprint — same tool
    // name, different hash — which is exactly what lapses a grant.
    const v1: ToolDescriptor = descriptor("write", { name: "host_drift" });
    const v2: ToolDescriptor = descriptor("destructive", { name: "host_drift" });
    expect(descriptorHash(v1)).not.toBe(descriptorHash(v2));

    // Round 1: the rule parks the call; approving with `remember` mints a
    // standing grant bound to v1's hash.
    const toolsV1 = new FixtureTools([v1]);
    const boundV1 = guard.bind(toolsV1);
    const parked1 = await boundV1.execute(call("host_drift", { x: 0 }, "drift_park_1"), context());
    if (parked1.status !== "pending-approval") throw new Error("expected round-1 park");
    await guard.approvals.decide(
      parked1.approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    // The minted grant (not the single-use approval) authorizes: a fresh call id
    // and args can never match the burned approval, so only the standing grant runs it.
    const granted1 = await boundV1.execute(call("host_drift", { x: 1 }, "drift_grant_1"), context());
    expect(granted1).toMatchObject({ status: "ok" });
    expect(toolsV1.executions).toHaveLength(1);

    // The descriptor drifts (write → destructive): the registry now serves v2.
    const toolsV2 = new FixtureTools([v2]);
    const boundV2 = guard.bind(toolsV2);

    // The v1 grant no longer matches the drifted hash, so the call parks again.
    const parked2 = await boundV2.execute(call("host_drift", { x: 2 }, "drift_park_2"), context());
    expect(parked2).toMatchObject({ status: "pending-approval" });
    expect(toolsV2.executions).toHaveLength(0);
    if (parked2.status !== "pending-approval") throw new Error("expected drift re-park");

    // Re-approving mints a second grant bound to v2's hash, which now authorizes.
    await guard.approvals.decide(
      parked2.approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );
    const granted2 = await boundV2.execute(call("host_drift", { x: 3 }, "drift_grant_2"), context());
    expect(granted2).toMatchObject({ status: "ok" });
    expect(toolsV2.executions).toHaveLength(1);

    // Both grants persist in the public SQL table: same tool, distinct hashes.
    const rows = await sqlStore.query<{ tool: string; descriptor_hash: string; source: string }>(
      "SELECT tool, descriptor_hash, source FROM vendo_grants ORDER BY granted_at",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.tool === "host_drift" && row.source === "chat")).toBe(true);
    expect(new Set(rows.rows.map((row) => row.descriptor_hash))).toEqual(
      new Set([descriptorHash(v1), descriptorHash(v2)]),
    );
  });
});

describe("deterministic breakers through bind (05 §2)", () => {
  it("call-rate breaker is per-principal and records decidedBy breaker in vendo_audit", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore, breakers: { maxCallsPerMinute: 1 } });
    const read = descriptor("read");
    const bound = guard.bind(new FixtureTools());

    // Alice's second call in the window trips the breaker; a would-be run parks.
    await expect(bound.execute(call(read.name, {}, "alice_1"), context())).resolves.toMatchObject({
      status: "ok",
    });
    await expect(bound.execute(call(read.name, {}, "alice_2"), context())).resolves.toMatchObject({
      status: "pending-approval",
    });
    // Bob's window is independent — his first call still runs.
    await expect(
      bound.execute(call(read.name, {}, "bob_1"), context({ principal: bob })),
    ).resolves.toMatchObject({ status: "ok" });

    const rows = await sqlStore.query<{
      subject: string;
      outcome: string | null;
      decided_by: string | null;
    }>(
      `SELECT subject, event->>'outcome' AS outcome, event->>'decidedBy' AS decided_by
       FROM vendo_audit WHERE kind = 'tool-call' ORDER BY at`,
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: alice.subject,
          outcome: "pending-approval",
          decided_by: "breaker",
        }),
        expect.objectContaining({ subject: bob.subject, outcome: "ok", decided_by: "default" }),
      ]),
    );
    // Alice tripped exactly once; her first call and bob's ran clean.
    const parked = rows.rows.filter((row) => row.outcome === "pending-approval");
    expect(parked).toHaveLength(1);
  });

  it("write-per-run breaker parks the over-budget write, ignores reads, and resets per run", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      breakers: { maxWritesPerRun: 1, maxCallsPerMinute: 100 },
    });
    const bound = guard.bind(new FixtureTools());
    const run1 = context({ trigger: { runId: "run_e2e_1", kind: "schedule" } });
    const run2 = context({ trigger: { runId: "run_e2e_2", kind: "schedule" } });

    // A read does not consume the write budget.
    await expect(bound.execute(call("host_read", {}, "r1"), run1)).resolves.toMatchObject({
      status: "ok",
    });
    // First write fits the budget; the second (21st-style) over-budget write parks.
    await expect(bound.execute(call("host_write", {}, "w1"), run1)).resolves.toMatchObject({
      status: "ok",
    });
    await expect(bound.execute(call("host_write", {}, "w2"), run1)).resolves.toMatchObject({
      status: "pending-approval",
    });
    // A new run resets the per-run budget.
    await expect(bound.execute(call("host_write", {}, "w3"), run2)).resolves.toMatchObject({
      status: "ok",
    });

    const rows = await sqlStore.query<{ outcome: string | null; decided_by: string | null }>(
      `SELECT event->>'outcome' AS outcome, event->>'decidedBy' AS decided_by
       FROM vendo_audit WHERE kind = 'tool-call' AND tool = 'host_write' ORDER BY at`,
    );
    const overBudget = rows.rows.find((row) => row.outcome === "pending-approval");
    expect(overBudget?.decided_by).toBe("breaker");
    // Exactly one write parked; w1 and w3 ran.
    expect(rows.rows.filter((row) => row.outcome === "ok")).toHaveLength(2);
  });
});

describe("critical tier is unsuppressible (05 §2 step 1, §4)", () => {
  it("still asks when a matching standing grant, a run rule, and a run judge all agree", async () => {
    const sqlStore = await store();
    const criticalDesc = descriptor("read", { name: "host_locked", critical: true });
    // A grant that would otherwise authorize the exact tool + hash.
    await seedGrant(sqlStore, { descriptor: criticalDesc });
    const guard = createGuard({
      store: sqlStore,
      policy: { rules: [{ match: {}, action: "run" }] },
      judge: { decide: async () => ({ action: "run", rationale: "judge says fine" }) },
    });

    // Critical short-circuits at stage 1: grant, rule, and judge never get to unlock it.
    await expect(
      guard.check(call(criticalDesc.name, {}, "crit_check"), criticalDesc, context()),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "critical" });

    const bound = guard.bind(new FixtureTools([criticalDesc]));
    await expect(
      bound.execute(call(criticalDesc.name, {}, "crit_exec"), context()),
    ).resolves.toMatchObject({ status: "pending-approval" });
  });
});
