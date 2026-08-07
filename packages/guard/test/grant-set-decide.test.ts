// Grant-set atomicity: a multi-id
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

  it("a member COMMIT failure compensates: second member's status write fails, the first rolls back, retry lands all-or-none", async () => {
    const sqlStore = await store();
    // Wrap the REAL store: the FIRST decided-status write for the injected id
    // throws (a storage fault mid-batch); everything else — including the
    // compensation's restore-to-pending writes — passes through untouched.
    let failStatusWriteFor: string | undefined;
    const faulty: PGliteStore = {
      ...sqlStore,
      records: (collection: string) => {
        const records = sqlStore.records(collection);
        if (collection !== "vendo_approvals") return records;
        return {
          get: (id: string) => records.get(id),
          delete: (id: string) => records.delete(id),
          list: (query?: Parameters<typeof records.list>[0]) => records.list(query),
          atomic: records.atomic,
          put: async (record: Parameters<typeof records.put>[0]) => {
            const status = (record.data as { status?: string }).status;
            if (record.id === failStatusWriteFor && status !== "pending") {
              failStatusWriteFor = undefined;
              throw new Error("injected: approval-status write failed");
            }
            return records.put(record);
          },
        };
      },
    } as PGliteStore;
    const guard = guardOf(faulty);
    const [a, b] = await parkPair(guard);
    let committed = 0;
    guard.onApprovalDecision(() => {
      committed += 1;
    });
    const [first, second] = [a, b].sort();
    failStatusWriteFor = second!;
    const remember = { scope: { kind: "tool" as const }, duration: "standing" as const };

    await expect(guard.approvals.decide([a, b], { approve: true, remember }, alice))
      .rejects.toThrow("injected: approval-status write failed");

    // All-or-none against the storage fault: the FIRST member (already
    // approved + granted) rolled back — both pending, no grants survive, no
    // subscriber ever observed the doomed set.
    expect(await statusOf(sqlStore, first!)).toBe("pending");
    expect(await statusOf(sqlStore, second!)).toBe("pending");
    expect(await guard.grants.list(alice)).toHaveLength(0);
    expect(committed).toBe(0);
    expect(await guard.approvals.pending(alice)).toHaveLength(2);

    // Failed-retryable: the same decision retried lands the whole set.
    await guard.approvals.decide([a, b], { approve: true, remember }, alice);
    expect(await statusOf(sqlStore, a)).toBe("approved");
    expect(await statusOf(sqlStore, b)).toBe("approved");
    expect(await guard.grants.list(alice)).toHaveLength(2);
    expect(committed).toBe(2);
  });

  it("when the ROLLBACK itself also fails, the partial state is loud: named error + setRollbackFailed audit — never silent", async () => {
    const sqlStore = await store();
    // Two injected faults: the second member's decided-status write throws
    // (triggering compensation), and the first member's restore-to-pending
    // write throws too (the rollback fails). The set must surface BOTH
    // loudly: a conflict error naming the approvals to review, and a
    // setRollbackFailed audit record — the one state that can never be quiet.
    let failCommitFor: string | undefined;
    let failRestoreFor: string | undefined;
    const faulty: PGliteStore = {
      ...sqlStore,
      records: (collection: string) => {
        const records = sqlStore.records(collection);
        if (collection !== "vendo_approvals") return records;
        return {
          get: (id: string) => records.get(id),
          delete: (id: string) => records.delete(id),
          list: (query?: Parameters<typeof records.list>[0]) => records.list(query),
          atomic: records.atomic,
          put: async (record: Parameters<typeof records.put>[0]) => {
            const status = (record.data as { status?: string }).status;
            if (record.id === failCommitFor && status !== "pending") {
              failCommitFor = undefined;
              throw new Error("injected: commit write failed");
            }
            if (record.id === failRestoreFor && status === "pending") {
              failRestoreFor = undefined;
              throw new Error("injected: restore write failed");
            }
            return records.put(record);
          },
        };
      },
    } as PGliteStore;
    const guard = guardOf(faulty);
    const [a, b] = await parkPair(guard);
    const [first, second] = [a, b].sort();
    failCommitFor = second!;
    failRestoreFor = first!;

    await expect(guard.approvals.decide([a, b], { approve: true }, alice))
      .rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining(`Review these approvals in Activity before retrying: ${first}`),
      });

    // The partial state is visible, not swallowed: the first member kept its
    // committed decision (restore failed), the second stayed pending, and the
    // ledger carries the rollback-failure record.
    expect(await statusOf(sqlStore, first!)).toBe("approved");
    expect(await statusOf(sqlStore, second!)).toBe("pending");
    const audit = await guard.audit.query({ principal: alice, limit: 50 });
    expect(audit.events.some(event =>
      (event.detail as { setRollbackFailed?: boolean } | undefined)?.setRollbackFailed === true)).toBe(true);
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
