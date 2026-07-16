import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, bob, call, context, FixtureTools } from "./fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

function askGuard(sqlStore: PGliteStore) {
  return createGuard({
    store: sqlStore,
    policy: { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] },
  });
}

/** AGENT-6: approvals the conversation walked away from are resolved
 *  guard-side — denied, no grant — instead of sitting pending forever. */
describe("abandoned approvals resolve guard-side", () => {
  it("denies a pending approval and audits the denial", async () => {
    const sqlStore = await store();
    const guard = askGuard(sqlStore);
    const bound = guard.bind(new FixtureTools());
    const ctx = context();

    const parked = await bound.execute(call("host_write", { value: 1 }, "call_abandon"), ctx);
    if (parked.status !== "pending-approval") throw new Error("expected the write to park");
    expect(await guard.approvals.pending(alice)).toHaveLength(1);

    await guard.abandonApprovals!([parked.approvalId], ctx);

    expect(await guard.approvals.pending(alice)).toHaveLength(0);
    expect(await guard.grants.list(alice)).toHaveLength(0);
    const { events } = await guard.audit.query({ subject: alice.subject });
    const decision = events.find((event) => event.kind === "approval");
    expect(decision?.detail).toMatchObject({ approved: false });
  });

  it("is idempotent and tolerant of a racing real decision", async () => {
    const sqlStore = await store();
    const guard = askGuard(sqlStore);
    const bound = guard.bind(new FixtureTools());
    const ctx = context();

    const parked = await bound.execute(call("host_write", { value: 2 }, "call_race"), ctx);
    if (parked.status !== "pending-approval") throw new Error("expected the write to park");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Already decided (and even unknown) ids abandon as a no-op, never a throw.
    await expect(guard.abandonApprovals!([parked.approvalId], ctx)).resolves.toBeUndefined();
    await expect(guard.abandonApprovals!(["apr_missing" as never], ctx)).resolves.toBeUndefined();
  });

  it("never resolves another subject's approval", async () => {
    const sqlStore = await store();
    const guard = askGuard(sqlStore);
    const bound = guard.bind(new FixtureTools());

    const parked = await bound.execute(call("host_write", { value: 3 }, "call_foreign"), context());
    if (parked.status !== "pending-approval") throw new Error("expected the write to park");

    await guard.abandonApprovals!([parked.approvalId], context({ principal: bob }));

    expect(await guard.approvals.pending(alice)).toHaveLength(1);
  });
});
