import type { RecordQuery, StoreAdapter } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
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

function guardOf(sqlStore: PGliteStore) {
  return createGuard({
    store: sqlStore,
    policy: { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] },
  });
}

/** Spec 2026-07-20 (#5): a TTL backstop over the general approvals collection,
 *  so away/automation/app approvals and approvals stranded by a mid-stream turn
 *  failure self-heal instead of piling up (the "513 pending" leak). Chat
 *  approvals are abandoned on the next thread turn and BYO parked calls have
 *  their own sweep; this covers everything else. Cross-subject; denies via the
 *  idempotent abandon path. */
describe("sweepExpiredApprovals", () => {
  async function parkWrite(guard: ReturnType<typeof guardOf>, principal = alice, id = "call_x") {
    const bound = guard.bind(new FixtureTools());
    const outcome = await bound.execute(call("host_write", { value: 1 }, id), context({ principal }));
    if (outcome.status !== "pending-approval") throw new Error("expected a parked write");
    return outcome.approvalId;
  }

  it("denies pending approvals older than the TTL, across subjects", async () => {
    const guard = guardOf(await store());
    await parkWrite(guard, alice, "call_a");
    await parkWrite(guard, bob, "call_b");
    expect(await guard.approvals.pending(alice)).toHaveLength(1);
    expect(await guard.approvals.pending(bob)).toHaveLength(1);

    const swept = await guard.sweepExpiredApprovals!(60_000, Date.now() + 61_000);
    expect(swept).toBe(2);
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
    expect(await guard.approvals.pending(bob)).toHaveLength(0);
  });

  it("leaves approvals younger than the TTL pending", async () => {
    const guard = guardOf(await store());
    await parkWrite(guard, alice, "call_fresh");
    const swept = await guard.sweepExpiredApprovals!(60_000, Date.now());
    expect(swept).toBe(0);
    expect(await guard.approvals.pending(alice)).toHaveLength(1);
  });

  it("is a no-op when the TTL is zero or negative (disabled)", async () => {
    const guard = guardOf(await store());
    await parkWrite(guard, alice, "call_off");
    expect(await guard.sweepExpiredApprovals!(0, Date.now() + 10_000_000)).toBe(0);
    expect(await guard.approvals.pending(alice)).toHaveLength(1);
  });

  // The sweep runs every 60s per process, forever. It must ask the store for
  // the pending set rather than paging every approval ever decided and
  // discarding the rest in JS — that read grows without bound on a live
  // deployment.
  it("asks the store for pending approvals only, never the whole collection", async () => {
    const base = createMemoryStore();
    const queries: (RecordQuery | undefined)[] = [];
    const spy: StoreAdapter = {
      ...base,
      records(collection) {
        const inner = base.records(collection);
        if (collection !== "vendo_approvals") return inner;
        return {
          ...inner,
          list: (query) => {
            queries.push(query);
            return inner.list(query);
          },
        };
      },
    };
    const guard = createGuard({
      store: spy,
      policy: { rules: [{ match: { risk: "write" }, action: "ask" }] },
    });
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_write", { value: 1 }, "call_spy"), context());
    if (parked.status !== "pending-approval") throw new Error("expected a parked write");
    await guard.approvals.decide(parked.approvalId, { approve: false }, alice);

    queries.length = 0;
    expect(await guard.sweepExpiredApprovals!(60_000, Date.now() + 61_000)).toBe(0);
    expect(queries).not.toHaveLength(0);
    for (const query of queries) expect(query?.refs).toMatchObject({ status: "pending" });
  });
});
