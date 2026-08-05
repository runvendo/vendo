import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, call, context, descriptor, FixtureTools, seedGrant } from "./fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

function freezeRow(sqlStore: PGliteStore, frozen: boolean, by: string): Promise<unknown> {
  return sqlStore.records("guard:controls").put({
    id: "freeze",
    data: { frozen, by, at: new Date().toISOString() },
  });
}

describe("the freeze flag over the real store", () => {
  it("blocks every call while frozen and runs again once lifted", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_read");
    // A standing grant is the strongest authority short of a live person: the
    // freeze has to outrank it too.
    await seedGrant(sqlStore, { descriptor: descriptor("destructive") });
    const granted = call("host_destructive", { invoiceId: "inv_1" }, "call_granted");

    expect(await guard.frozen()).toBe(false);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });

    await guard.freeze("ops_yousef");
    expect(await guard.frozen()).toBe(true);

    // Even a DECLARED READ under no policy at all — the call the guard would
    // otherwise run without asking anyone.
    expect(await guard.check(read, descriptor("read"), context())).toEqual({
      action: "block",
      reason: "vendo is frozen — nothing runs until it is unfrozen",
      decidedBy: "frozen",
    });
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    await expect(bound.execute(granted, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(1);

    await guard.unfreeze("ops_yousef");
    expect(await guard.frozen()).toBe(false);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });
    await expect(bound.execute(granted, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(3);
  });

  it("writes the flag row the console reads, and audits both directions plus every blocked call", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const bound = guard.bind(new FixtureTools());

    await guard.freeze("ops_yousef");
    const row = await sqlStore.query<{ data: { frozen: boolean; by: string; at: string } }>(
      "SELECT data FROM vendo_records WHERE collection = $1 AND id = $2",
      ["guard:controls", "freeze"],
    );
    expect(row.rows[0]?.data).toMatchObject({ frozen: true, by: "ops_yousef" });
    expect(row.rows[0]?.data.at).toEqual(expect.any(String));

    await bound.execute(call("host_write", { invoiceId: "inv_2" }, "call_write"), context());
    await guard.unfreeze("ops_yousef");

    const events = (await guard.audit.query({ kind: "policy-decision", limit: 50 })).events;
    expect(events).toHaveLength(3);
    const flips = events.filter((event) => event.principal.subject === "ops_yousef");
    expect(flips.map((event) => (event.detail as { reason?: unknown }).reason).sort()).toEqual([
      "frozen",
      "unfrozen",
    ]);
    expect(flips.map((event) => event.decidedBy)).toEqual(["frozen", "frozen"]);
    expect(events.find((event) => event.tool === "host_write")).toMatchObject({
      outcome: "blocked",
      decidedBy: "frozen",
      principal: { subject: alice.subject },
    });
  });

  it("obeys a flag row written straight through the store, as the console writes it", async () => {
    const sqlStore = await store();
    const guard = createGuard({ store: sqlStore });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const read = call("host_read", { value: 1 }, "call_console");

    await freezeRow(sqlStore, true, "console");
    expect(await guard.frozen()).toBe(true);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "blocked" });
    expect(tools.executions).toHaveLength(0);

    await freezeRow(sqlStore, false, "console");
    expect(await guard.frozen()).toBe(false);
    await expect(bound.execute(read, context())).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });
});
