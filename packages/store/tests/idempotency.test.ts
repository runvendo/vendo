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
  });
}
