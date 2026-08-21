import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import type { IdempotencyLedger } from "@vendoai/core";

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

    // The filed race (#1297), fired at one instant against a real database
    // rather than asserted in sequence: sequential cases pass just as happily on
    // the check-then-do shape this verb replaces.
    it("two concurrent claims on one key with DIFFERENT bodies: one reserves, the other is refused before it mutates", async () => {
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_race_bodies" };
      const settled = await Promise.allSettled([
        ledger.claim!(raced, "hash_first"),
        ledger.claim!(raced, "hash_second"),
      ]);
      const won = settled.filter((one) => one.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect((won[0] as PromiseFulfilledResult<unknown>).value).toBe("claimed");
      // The refusal is the whole point, and it arrives INSTEAD of the mutation
      // rather than after it — the caller has not been told to go do any work.
      const refused = settled.find((one) => one.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: "conflict" });
      // One row, holding the winner's hash and still unanswered: the loser
      // neither reserved the key nor stamped its body onto the winner's row.
      const rows = await made.sql(
        "SELECT request_hash, status FROM vendo_idempotency_ledger WHERE tenant = $1 AND op = $2 AND key = $3",
        [raced.tenant, raced.op, raced.key],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!["request_hash"]).toBe(settled[0]!.status === "fulfilled" ? "hash_first" : "hash_second");
      expect(Number(rows[0]!["status"])).toBe(0);
    });

    // The benign half: one key, one body, one effect. A contender is told to
    // PROCEED, not to wait — a contender that waited would hang behind an owner
    // that died before `record`, which is the ordinary client-timeout retry.
    it("two concurrent claims on one key with the SAME body: one reserves, the other is told to proceed", async () => {
      const raced = { tenant: "tenant_a", op: "workspace.commit", key: "key_race_same" };
      const settled = await Promise.all([ledger.claim!(raced, "hash_same"), ledger.claim!(raced, "hash_same")]);
      expect(settled.filter((one) => one === "claimed")).toHaveLength(1);
      expect(settled.filter((one) => one === null)).toHaveLength(1);
    });

    // An owner that never returns leaves a reservation behind. Nothing may be
    // stuck on it: the retry carrying the same key is told to proceed and its
    // `record` settles the key, so a dropped request costs an execution, never
    // the key itself.
    it("a reservation whose owner never answered does not strand the key", async () => {
      const dropped = { tenant: "tenant_a", op: "workspace.commit", key: "key_dropped" };
      expect(await ledger.claim!(dropped, "hash_d")).toBe("claimed");
      expect(await ledger.check(dropped, "hash_d")).toBeNull();
      expect(await ledger.claim!(dropped, "hash_d")).toBeNull();
      await ledger.record(dropped, "hash_d", { status: 200, result: { retried: true } });
      expect(await ledger.check(dropped, "hash_d")).toEqual({ status: 200, result: { retried: true } });
    });

    // `record` settles the reservation it owns and nothing else. Reachable only
    // through the `check` fallback — `claim` refuses a differing hash outright —
    // which is exactly why it must hold there too.
    it("record does not settle another request's reservation, and does not overwrite a settled one", async () => {
      const held = { tenant: "tenant_a", op: "workspace.commit", key: "key_settle" };
      expect(await ledger.claim!(held, "hash_owner")).toBe("claimed");
      await ledger.record(held, "hash_other", { status: 200, result: { whose: "other" } });
      expect(await ledger.check(held, "hash_owner")).toBeNull();
      await ledger.record(held, "hash_owner", { status: 201, result: { whose: "owner" } });
      await ledger.record(held, "hash_owner", { status: 500, result: { whose: "late" } });
      expect(await ledger.check(held, "hash_owner")).toEqual({ status: 201, result: { whose: "owner" } });
    });
  });
}
