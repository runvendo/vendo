import { descriptorHash } from "@vendoai/core";
import type { ApprovalRequest, StoreAdapter } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { createPGliteStore, type PGliteStore } from "../fixtures/pglite-store.js";
import { FixtureTools, alice, call, context, descriptor } from "../fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

/** A StoreAdapter whose record stores omit the optional atomic-claims
 *  capability (02-store §4) — models an alternate adapter that cannot do
 *  database-level compare-and-claim. */
function withoutAtomic(base: StoreAdapter): StoreAdapter {
  return {
    ...base,
    records(collection) {
      const { atomic: _atomic, ...rest } = base.records(collection);
      return rest;
    },
  };
}

// The single-use guarantee must come from the STORE's atomicity, not from
// process-local locking: a Next.js host on Vercel runs many instances against
// one Postgres, so two replicas racing the same approval is the real topology.
describe("approval single-use holds across guard instances (store CAS)", () => {
  it("two guard instances consume one approved replay exactly once", async () => {
    const sqlStore = await store();
    const config = { store: sqlStore, policy: { rules: [{ match: {}, action: "ask" as const }] } };
    const toolsA = new FixtureTools();
    const toolsB = new FixtureTools();
    const boundA = createGuard(config).bind(toolsA);
    const boundB = createGuard(config).bind(toolsB);
    const c = call("host_write", { amount: 7 }, "call_xproc");

    const parked = await boundA.execute(c, context());
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");
    await createGuard(config).approvals.decide(parked.approvalId, { approve: true }, alice);

    // Two simultaneous replays from DIFFERENT instances: exactly one runs.
    const [a, b] = await Promise.all([boundA.execute(c, context()), boundB.execute(c, context())]);
    expect([a.status, b.status].sort()).toEqual(["ok", "pending-approval"]);
    expect(toolsA.executions.length + toolsB.executions.length).toBe(1);
  });

  it("two guard instances racing approve vs deny land exactly one decision", async () => {
    const sqlStore = await store();
    const config = { store: sqlStore, policy: { rules: [{ match: {}, action: "ask" as const }] } };
    const guardA = createGuard(config);
    const guardB = createGuard(config);
    const bound = guardA.bind(new FixtureTools());

    const parked = await bound.execute(call("host_write", { n: 1 }, "call_xdecide"), context());
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");

    const results = await Promise.allSettled([
      guardA.approvals.decide(
        parked.approvalId,
        { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        alice,
      ),
      guardB.approvals.decide(parked.approvalId, { approve: false }, alice),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const rows = await sqlStore.query<{ status: string }>(
      "SELECT status FROM vendo_approvals WHERE id = $1",
      [parked.approvalId],
    );
    expect(["approved", "denied"]).toContain(rows.rows[0]?.status);
    // A denial that lost never minted; an approval that lost never minted either.
    const grants = await sqlStore.query<{ id: string }>("SELECT id FROM vendo_grants");
    expect(grants.rows.length).toBe(rows.rows[0]?.status === "approved" ? 1 : 0);
  });
});

// 02-store §4: consumers that require single-use state fail closed when an
// alternate adapter omits the atomic-claims capability.
describe("approvals fail closed without the store's atomic claims", () => {
  it("refuses to decide an approval on a claim-less adapter", async () => {
    const guard = createGuard({
      store: withoutAtomic(createMemoryStore()),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_write", { amount: 5 }, "call_noatomic"), context());
    if (parked.status !== "pending-approval") throw new Error("expected the call to park");

    await expect(
      guard.approvals.decide(parked.approvalId, { approve: true }, alice),
    ).rejects.toMatchObject({ code: "not-implemented" });
  });

  it("refuses to consume an approved replay on a claim-less adapter", async () => {
    const base = createMemoryStore();
    const guard = createGuard({
      store: withoutAtomic(base),
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call("host_write", { amount: 5 }, "call_seeded");
    const request: ApprovalRequest = {
      id: "apr_seeded",
      call: c,
      descriptor: descriptor("write"),
      inputPreview: 'host_write {"amount":5}',
      ctx: { principal: alice, venue: "chat", presence: "present" },
      createdAt: new Date().toISOString(),
    };
    expect(descriptorHash(request.descriptor)).toBe(descriptorHash(descriptor("write")));
    await base.records("vendo_approvals").put({
      id: request.id,
      data: {
        request,
        status: "approved",
        decidedAt: new Date().toISOString(),
        sessionId: "session_1",
      },
      refs: { subject: alice.subject, status: "approved" },
    });

    await expect(bound.execute(c, context())).rejects.toMatchObject({ code: "not-implemented" });
    expect(tools.executions).toHaveLength(0);
  });
});
