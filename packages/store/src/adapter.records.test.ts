import { VendoError, isoDateTimeSchema } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appStore } from "./index.js";
import { appFixture, persistentPrincipal } from "./fixtures.test-util.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      // ENG-237: app-scoped record collections (app:<id>:*) now require an
      // owning app row (writes to an unknown app fail closed — STORE-1). These
      // generic-store tests use app: collections as opaque namespaces, so give
      // them durable owning apps; durable routing is otherwise unchanged.
      for (const id of ["app_a", "app_b"]) await appStore(made.store).put(persistentPrincipal, appFixture(id));
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("round-trips, updates, deletes, and emits ISO timestamps", async () => {
      const records = made.store.records("app:app_a:notes");
      const first = await records.put({ id: "note_1", data: { text: "first" }, refs: { invoice_id: "inv_1" } });
      expect(isoDateTimeSchema.parse(first.createdAt)).toBe(first.createdAt);
      expect(isoDateTimeSchema.parse(first.updatedAt)).toBe(first.updatedAt);
      expect(await records.get("note_1")).toEqual(first);

      await made.sql(
        "UPDATE vendo_records SET created_at = $1, updated_at = $1 WHERE collection = $2 AND id = $3",
        ["2020-01-01T00:00:00.000Z", "app:app_a:notes", "note_1"],
      );
      const second = await records.put({ id: "note_1", data: { text: "second" }, refs: { invoice_id: "inv_2" } });
      expect(second.createdAt).toBe("2020-01-01T00:00:00.000Z");
      expect(second.updatedAt > second.createdAt).toBe(true);
      expect(second.data).toEqual({ text: "second" });
      expect(second.refs).toEqual({ invoice_id: "inv_2" });

      await records.delete("note_1");
      expect(await records.get("note_1")).toBeNull();
    });

    it("atomically inserts one claimant and lets only one matching revision swap win", async () => {
      const records = made.store.records("automations:claims");
      expect(records.atomic).toBeDefined();
      const atomic = records.atomic!;

      const claims = await Promise.all(Array.from({ length: 8 }, (_, claimant) =>
        atomic.insertIfAbsent({ id: "claim_1", data: { claimant } })));
      const winners = claims.filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.revision).toBeDefined();

      const revision = winners[0]!.revision!;
      const swaps = await Promise.all([
        atomic.compareAndSwap({ id: "claim_1", data: { claimant: "a" } }, revision),
        atomic.compareAndSwap({ id: "claim_1", data: { claimant: "b" } }, revision),
      ]);
      expect(swaps.filter((record) => record !== null)).toHaveLength(1);
      expect((await records.get("claim_1"))?.revision).not.toBe(revision);
    });

    it("filters by ids and refs containment", async () => {
      const records = made.store.records("app:app_a:filters");
      await records.put({ id: "flt_a", data: { n: 1 }, refs: { owner: "one", kind: "invoice" } });
      await records.put({ id: "flt_b", data: { n: 2 }, refs: { owner: "one" } });
      await records.put({ id: "flt_c", data: { n: 3 }, refs: { owner: "two", kind: "invoice" } });
      expect((await records.list({ ids: ["flt_a", "flt_c"] })).records.map((r) => r.id).sort()).toEqual(["flt_a", "flt_c"]);
      expect((await records.list({ refs: { owner: "one", kind: "invoice" } })).records.map((r) => r.id)).toEqual(["flt_a"]);
    });

    it("walks keyset pages without duplicates, misses, or a terminal cursor", async () => {
      const records = made.store.records("app:app_a:pages");
      const expected = Array.from({ length: 15 }, (_, index) => `page_${String(index).padStart(2, "0")}`);
      for (const id of expected) await records.put({ id, data: { id } });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await records.list({ limit: 5, cursor });
        seen.push(...page.records.map((record) => record.id));
        if (page.cursor === undefined) {
          expect(page.records).toHaveLength(5);
          break;
        }
        cursor = page.cursor;
      }
      expect(new Set(seen).size).toBe(15);
      expect([...seen].sort()).toEqual(expected);
      const final = await records.list({ limit: 5, cursor });
      expect(final.cursor).toBeUndefined();
    });

    it("isolates collections with identical ids", async () => {
      const a = made.store.records("app:app_a:notes");
      const b = made.store.records("app:app_b:notes");
      await a.put({ id: "shared_note", data: { app: "a" } });
      await b.put({ id: "shared_note", data: { app: "b" } });
      expect((await a.get("shared_note"))?.data).toEqual({ app: "a" });
      expect((await b.get("shared_note"))?.data).toEqual({ app: "b" });
    });

    it("atomically compares and claims a record exactly once", async () => {
      const firstHandle = made.store.records("atomic_claims");
      const secondHandle = made.store.records("atomic_claims");
      const expected = await firstHandle.put({
        id: "claim_1",
        data: { status: "unclaimed" },
        refs: { owner: "user_1" },
      });

      expect(firstHandle.claim).toBeTypeOf("function");
      expect(secondHandle.claim).toBeTypeOf("function");
      if (!firstHandle.claim || !secondHandle.claim) throw new Error("store does not support atomic claims");

      const [first, second] = await Promise.all([
        firstHandle.claim(expected, {
          data: { status: "claimed", winner: "first" },
          refs: expected.refs,
        }),
        secondHandle.claim(expected, {
          data: { status: "claimed", winner: "second" },
          refs: expected.refs,
        }),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect((await firstHandle.get(expected.id))?.data).toEqual({
        status: "claimed",
        winner: first ? "first" : "second",
      });

      // A stale compare cannot consume the winner's row. The current value can.
      expect(await firstHandle.claim(expected)).toBe(false);
      const current = await firstHandle.get(expected.id);
      expect(current).not.toBeNull();
      expect(await firstHandle.claim(current!)).toBe(true);
      expect(await firstHandle.get(expected.id)).toBeNull();
    });

    it("guards generic claims with the observed revision across an intervening same-value write", async () => {
      const collection = "revision_guarded_claims";
      const records = made.store.records(collection);
      const expected = await records.put({
        id: "claim_aba",
        data: { status: "unclaimed" },
        refs: { owner: "user_1" },
      });
      expect(expected.revision).toBeDefined();
      if (!records.claim) throw new Error("store does not support atomic claims");

      type RawQuery = (
        text: string,
        params?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>;
      const raw = made.store.raw() as { query: RawQuery };
      const originalQuery = raw.query.bind(raw);
      let intercepted = false;
      raw.query = async (text, params = []) => {
        const result = await originalQuery(text, params);
        if (
          !intercepted
          && text.includes("SELECT id, data, refs, created_at, updated_at, revision FROM vendo_records")
          && params[0] === collection
          && params[1] === expected.id
        ) {
          intercepted = true;
          await originalQuery(
            "UPDATE vendo_records SET revision = revision + 1 WHERE collection = $1 AND id = $2",
            [collection, expected.id],
          );
        }
        return result;
      };

      try {
        expect(await records.claim(expected, {
          data: { status: "claimed" },
          refs: expected.refs,
        })).toBe(false);
      } finally {
        raw.query = originalQuery;
      }

      expect(intercepted).toBe(true);
      const current = await records.get(expected.id);
      expect(current).toMatchObject({
        data: expected.data,
        refs: expected.refs,
      });
      expect(current?.revision).toBeDefined();
      expect(current?.revision).not.toBe(expected.revision);
    });

    it("rejects malformed cursors as validation errors", async () => {
      const records = made.store.records("cursor_errors");
      const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
      const malformed = [
        "not-a-cursor",
        encode({ c: "2026", i: "record_1" }),
        `${encode({ c: "2026-01-02T03:04:05.000Z", i: "record_1" })}!!`,
        encode({ c: "2026-01-02T03:04:05.000Z", i: "record_1", extra: true }),
      ];
      for (const cursor of malformed) {
        await expect(records.list({ cursor })).rejects.toMatchObject<VendoError>({
          code: "validation",
          message: "malformed cursor",
        });
      }
    });
  });
}
