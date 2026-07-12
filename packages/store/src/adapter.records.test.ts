import { VendoError, isoDateTimeSchema } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
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

    it("rejects malformed cursors as validation errors", async () => {
      await expect(made.store.records("cursor_errors").list({ cursor: "not-a-cursor" }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
    });
  });
}
