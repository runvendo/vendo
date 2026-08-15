import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import type { IdempotencyLedger } from "@vendoai/core";
import type { Db } from "../src/db-postgres.js";
import { createIdempotencyLedger, maybeDbFor } from "../src/index.js";

// 01 §12 — the `Idempotency-Key` replay ledger, served off the same database as
// the mutations it gates. `createStore()` hands one out, so a mount never has to
// wire a second store up (and never can put the ledger somewhere that commits
// independently of the work it is recording).
const scope = { tenant: "tenant_a", op: "workspace.commit", key: "key_1" };

for (const backend of backends()) {
  describe(`${backend.name} idempotency ledger`, () => {
    let made: MadeBackend;
    let ledger: IdempotencyLedger;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      ledger = made.store.idempotency!;
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("createStore hands out a ledger", () => {
      expect(made.store.idempotency).toBeDefined();
    });

    it("replays what a key already answered, and only for the same request body", async () => {
      expect(await ledger.check(scope, "hash_1")).toBeNull();
      await ledger.record(scope, "hash_1", { status: 201, result: { id: "wsc_1" } });
      expect(await ledger.check(scope, "hash_1")).toEqual({ status: 201, result: { id: "wsc_1" } });
      // The same key with a DIFFERENT body is a client bug, not a replay: there
      // is no recorded answer that belongs to it, so it must never receive the
      // other request's.
      await expect(ledger.check(scope, "hash_2")).rejects.toMatchObject({ code: "conflict" });
    });

    it("is scoped by tenant and op, so one key cannot answer another's request", async () => {
      expect(await ledger.check({ ...scope, tenant: "tenant_b" }, "hash_1")).toBeNull();
      expect(await ledger.check({ ...scope, op: "engine.put" }, "hash_1")).toBeNull();
    });

    it("keeps the FIRST answer: a later record for a held key is a no-op", async () => {
      await ledger.record(scope, "hash_1", { status: 500, result: { error: "late" } });
      expect(await ledger.check(scope, "hash_1")).toEqual({ status: 201, result: { id: "wsc_1" } });
    });

    it("claim refuses a different-body racer before it writes", async () => {
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_claim_diff" };
      const claim = ledger.claim;
      if (claim === undefined) throw new Error("createStore ledger must serve claim");
      const writes: string[] = [];
      const run = async (hash: string, body: string): Promise<unknown> => {
        const got = await claim(raced, hash);
        if (got !== "claimed") return got;
        writes.push(body);
        await ledger.record(raced, hash, { status: 200, result: { body } });
        return "claimed";
      };
      const settled = await Promise.allSettled([run("hash_a", "a"), run("hash_b", "b")]);
      expect(writes).toHaveLength(1);
      expect(settled.filter((one) => one.status === "fulfilled")).toHaveLength(1);
      const loser = settled.find((one) => one.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: "conflict" });
      const winner = writes[0]!;
      expect(await ledger.check(raced, winner === "a" ? "hash_a" : "hash_b"))
        .toEqual({ status: 200, result: { body: winner } });
    });

    it("claim: same-hash racers run the mutation once and the loser replays", async () => {
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_claim_same" };
      const claim = ledger.claim;
      if (claim === undefined) throw new Error("createStore ledger must serve claim");
      const writes: string[] = [];
      const run = async (): Promise<unknown> => {
        const got = await claim(raced, "hash_a");
        if (got !== "claimed") return got;
        writes.push("a");
        await ledger.record(raced, "hash_a", { status: 201, result: { id: "once" } });
        return "claimed";
      };
      const settled = await Promise.all([run(), run()]);
      expect(writes).toEqual(["a"]);
      expect(settled.filter((one) => one === "claimed")).toHaveLength(1);
      expect(settled.find((one) => one !== "claimed")).toEqual({ status: 201, result: { id: "once" } });
    });

    it("keeps every previously valid 503 answer replayable", async () => {
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_claim_status" };
      await ledger.record(raced, "hash_a", {
        status: 503,
        result: { __vendo_idempotency_pending_v1: true },
      });
      expect(await ledger.check(raced, "hash_a"))
        .toEqual({ status: 503, result: { __vendo_idempotency_pending_v1: true } });
    });

    it("restores the transaction's lock timeout after claiming", async () => {
      const db = maybeDbFor(made.store);
      if (db === undefined) throw new Error("createStore must expose its database handle");
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_claim_timeout_restore" };
      await db.transaction(async (query) => {
        const before = (await query("SHOW lock_timeout")).rows[0]?.["lock_timeout"];
        const txLedger = createIdempotencyLedger({ ...db, query }, { waitTimeoutMs: 25 });
        expect(await txLedger.claim!(raced, "hash_a")).toBe("claimed");
        expect((await query("SHOW lock_timeout")).rows[0]?.["lock_timeout"]).toBe(before);
        await txLedger.record(raced, "hash_a", { status: 200, result: { committed: true } });
      });
    });

    it("lets a retry claim after the owner's transaction rolls back", async () => {
      const db = maybeDbFor(made.store);
      if (db === undefined) throw new Error("createStore must expose its database handle");
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_claim_rollback" };
      await expect(db.transaction(async (query) => {
        const txLedger = createIdempotencyLedger({ ...db, query });
        expect(await txLedger.claim!(raced, "hash_a")).toBe("claimed");
        throw new Error("roll back the owner");
      })).rejects.toThrow("roll back the owner");

      expect(await ledger.claim!(raced, "hash_a")).toBe("claimed");
      await ledger.record(raced, "hash_a", { status: 200, result: { committed: true } });
    });

    it("bounds claim acquisition behind an uncommitted owner", async () => {
      const db = maybeDbFor(made.store);
      if (db === undefined) throw new Error("createStore must expose its database handle");
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_claim_blocked" };
      let releaseOwner!: () => void;
      let ownerReady!: () => void;
      const held = new Promise<void>((resolve) => { releaseOwner = resolve; });
      const ready = new Promise<void>((resolve) => { ownerReady = resolve; });
      const owner = db.transaction(async (query) => {
        const txLedger = createIdempotencyLedger({ ...db, query }, { waitTimeoutMs: 25 });
        expect(await txLedger.claim!(raced, "hash_a")).toBe("claimed");
        ownerReady();
        await held;
        await txLedger.record(raced, "hash_a", { status: 200, result: { committed: true } });
      });
      await ready;
      try {
        const contender = createIdempotencyLedger(db, { waitTimeoutMs: 25 });
        await expect(contender.claim!(raced, "hash_a"))
          .rejects.toMatchObject({ code: "unavailable" });
      } finally {
        releaseOwner();
        await owner;
      }
    });
  });
}

const queryOnlyDb = (query: Db["query"]): Db => ({
  kind: "pglite",
  query,
  async close() {},
  raw: () => undefined,
  withSchemaLock: async (work) => work(query),
  transaction: async (work) => work(query),
});

describe("idempotency query deadlines", () => {
  it.each(["check", "claim"] as const)("bounds a queued SELECT during %s", async (operation) => {
    const queued = new Promise<{ rows: Record<string, unknown>[] }>((resolve) => {
      setTimeout(() => resolve({ rows: [] }), 200);
    });
    const db = queryOnlyDb(async (sql) => (
      sql.includes("INSERT INTO vendo_idempotency_ledger") ? { rows: [] } : queued
    ));
    const ledger = createIdempotencyLedger(db, { waitTimeoutMs: 25 });
    const started = Date.now();

    const call = operation === "check"
      ? ledger.check(scope, "hash_queued")
      : ledger.claim!(scope, "hash_queued");
    await expect(call).rejects.toMatchObject({ code: "unavailable" });
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("clears its deadline timer when the claim INSERT rejects", async () => {
    vi.useFakeTimers();
    try {
      const db = queryOnlyDb(async () => { throw new Error("query failed"); });
      const ledger = createIdempotencyLedger(db, { waitTimeoutMs: 2_000 });
      await expect(ledger.claim!(scope, "hash_failed")).rejects.toThrow("query failed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps PostgreSQL lock timeouts to unavailable without leaving a timer", async () => {
    vi.useFakeTimers();
    try {
      const db = queryOnlyDb(async () => { throw Object.assign(new Error("lock timeout"), { code: "55P03" }); });
      const ledger = createIdempotencyLedger(db, { waitTimeoutMs: 2_000 });
      await expect(ledger.claim!(scope, "hash_locked")).rejects.toMatchObject({ code: "unavailable" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences late INSERT cleanup to the timed-out claim generation", async () => {
    let finishInsert!: (result: { rows: Record<string, unknown>[] }) => void;
    const insert = new Promise<{ rows: Record<string, unknown>[] }>((resolve) => {
      finishInsert = resolve;
    });
    let insertedToken: unknown;
    let replacementToken: unknown;
    let cleanupToken: unknown;
    const db = queryOnlyDb(async (sql, params = []) => {
      if (sql.includes("INSERT INTO vendo_idempotency_ledger")) {
        insertedToken = params[5];
        return insert;
      }
      if (sql.includes("DELETE FROM vendo_idempotency_ledger")) {
        cleanupToken = params[4];
        if (cleanupToken === replacementToken) replacementToken = undefined;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const ledger = createIdempotencyLedger(db, { waitTimeoutMs: 25 });

    await expect(ledger.claim!(scope, "hash_late")).rejects.toMatchObject({ code: "unavailable" });
    replacementToken = "replacement-claim-token";
    finishInsert({ rows: [{ claim_token: insertedToken }] });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(cleanupToken).toBe(insertedToken);
    expect(replacementToken).toBe("replacement-claim-token");
  });
});
