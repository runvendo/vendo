// Grant-set atomicity (demo-live-readiness, criterion 19): a multi-id
// approvals.decide is ONE set decision and must land all-or-none over the
// REAL store transaction (atomic transition receipts), never a partially
// granted set. Semantics under contention:
//   - a member already decided in the SAME direction is skipped, the
//     remainder still lands atomically (final state = the set's goal state);
//   - a member decided in the OPPOSITE direction aborts the whole batch with
//     nothing written;
//   - concurrent deciders resolve to exactly one commit per member — the
//     final state is never mixed.
import { VendoError } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, call, context, FixtureTools } from "./fixtures/tools.js";

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

/** Parks two guarded writes — the two-member "grant set" every test decides. */
async function parkPair(guard: ReturnType<typeof guardOf>) {
  const bound = guard.bind(new FixtureTools());
  const ids: string[] = [];
  for (const id of ["call_set_a", "call_set_b"]) {
    const outcome = await bound.execute(call("host_write", { value: 1 }, id), context({ principal: alice }));
    if (outcome.status !== "pending-approval") throw new Error("expected a parked write");
    ids.push(outcome.approvalId);
  }
  return ids as [string, string];
}

async function statusOf(sqlStore: PGliteStore, id: string): Promise<string> {
  const record = await sqlStore.records("vendo_approvals").get(id);
  return (record?.data as { status?: string }).status ?? "missing";
}

describe("grant-set decide atomicity (real store transaction)", () => {
  it("a batch approve lands every member", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a, b] = await parkPair(guard);

    await guard.approvals.decide([a, b], { approve: true }, alice);

    expect(await statusOf(sqlStore, a)).toBe("approved");
    expect(await statusOf(sqlStore, b)).toBe("approved");
    expect(await guard.approvals.pending(alice)).toHaveLength(0);
  });

  it("skips a member already approved elsewhere — the remainder still lands and the final state is all-granted", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a, b] = await parkPair(guard);
    await guard.approvals.decide(a, { approve: true }, alice);

    await guard.approvals.decide([a, b], { approve: true }, alice);

    expect(await statusOf(sqlStore, a)).toBe("approved");
    expect(await statusOf(sqlStore, b)).toBe("approved");
  });

  it("a pre-DENIED member aborts the whole approve batch with nothing written", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a, b] = await parkPair(guard);
    await guard.approvals.decide(a, { approve: false }, alice);

    await expect(guard.approvals.decide([a, b], { approve: true }, alice))
      .rejects.toMatchObject({ code: "conflict" });

    // The sibling was NOT decided as a side effect of the failed batch.
    expect(await statusOf(sqlStore, a)).toBe("denied");
    expect(await statusOf(sqlStore, b)).toBe("pending");
    // ...and it is still decidable afterwards (no stuck claim receipt).
    await guard.approvals.decide([b], { approve: true }, alice);
    expect(await statusOf(sqlStore, b)).toBe("approved");
  });

  it("a pre-APPROVED member aborts a deny batch symmetrically", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a, b] = await parkPair(guard);
    await guard.approvals.decide(a, { approve: true }, alice);

    await expect(guard.approvals.decide([a, b], { approve: false }, alice))
      .rejects.toMatchObject({ code: "conflict" });

    expect(await statusOf(sqlStore, b)).toBe("pending");
  });

  it("concurrent same-direction decides from two surfaces commit each member exactly once", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a, b] = await parkPair(guard);
    let committed = 0;
    guard.onApprovalDecision(() => {
      committed += 1;
    });

    const results = await Promise.allSettled([
      guard.approvals.decide([a, b], { approve: true }, alice),
      guard.approvals.decide([a, b], { approve: true }, alice),
    ]);

    // Every loser fails with the conflict a late decider sees — never a crash,
    // never a partial write.
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(VendoError);
        expect((result.reason as VendoError).code).toBe("conflict");
      }
    }
    expect(await statusOf(sqlStore, a)).toBe("approved");
    expect(await statusOf(sqlStore, b)).toBe("approved");
    // Exactly one commit per member across BOTH racers.
    expect(committed).toBe(2);
  });

  it("a concurrent approve and deny never mix — the set ends all-approved or all-denied", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a, b] = await parkPair(guard);

    const results = await Promise.allSettled([
      guard.approvals.decide([a, b], { approve: true }, alice),
      guard.approvals.decide([a, b], { approve: false }, alice),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        expect((result.reason as VendoError).code).toBe("conflict");
      }
    }
    const statusA = await statusOf(sqlStore, a);
    const statusB = await statusOf(sqlStore, b);
    expect(statusA).toBe(statusB);
    expect(["approved", "denied"]).toContain(statusA);
  });

  it("single-id decides keep the strict one-time transition (same-direction re-decide still conflicts)", async () => {
    const sqlStore = await store();
    const guard = guardOf(sqlStore);
    const [a] = await parkPair(guard);
    await guard.approvals.decide(a, { approve: true }, alice);

    await expect(guard.approvals.decide(a, { approve: true }, alice))
      .rejects.toMatchObject({ code: "conflict" });
  });
});
