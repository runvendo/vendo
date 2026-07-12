import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";

// Adversarial regression suite for record-collection isolation and SQL-injection
// resistance (01-core §12 / 02-store §2). Collection names are opaque tags that
// route to parameterized queries — an attacker who controls the tag must not be
// able to cross a namespace boundary or break out into raw SQL.

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("isolates two apps' identically-named collections", async () => {
      const a = made.store.records("app:app_AAA:notes");
      const b = made.store.records("app:app_BBB:notes");
      await a.put({ id: "note_1", data: { owner: "AAA" } });
      await b.put({ id: "note_2", data: { owner: "BBB" } });

      // Each app sees only its own record; neither leaks into the other.
      expect((await a.list()).records.map((r) => r.id)).toEqual(["note_1"]);
      expect((await b.list()).records.map((r) => r.id)).toEqual(["note_2"]);
      expect(await a.get("note_2")).toBeNull();
      expect(await b.get("note_1")).toBeNull();
    });

    it("treats a collection tag full of SQL metacharacters as a literal (parameterized)", async () => {
      const evil = "app:app_X:'; DROP TABLE vendo_records;--";
      const records = made.store.records(evil);
      await records.put({ id: "rec_1", data: { safe: true } });

      // Round-trips as a literal tag: the injection is inert.
      expect((await records.get("rec_1"))?.data).toEqual({ safe: true });

      // The table still exists and other collections are intact afterward.
      const other = made.store.records("app:app_Y:notes");
      await other.put({ id: "rec_2", data: { ok: 1 } });
      expect((await other.get("rec_2"))?.data).toEqual({ ok: 1 });
      const rows = await made.sql("SELECT count(*)::int AS n FROM vendo_records");
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
    });

    it("keeps a colon-bearing suffix inside its own appId prefix (no namespace forgery)", async () => {
      // A hostile suffix that embeds another appId's namespace must stay scoped to
      // the FULL literal tag — it cannot forge a read into app_BBB's collection.
      const forger = made.store.records("app:app_AAA:notes:app:app_BBB:notes");
      await forger.put({ id: "forge_1", data: { intent: "escape" } });

      const victim = made.store.records("app:app_BBB:notes");
      expect(await victim.get("forge_1")).toBeNull();
      expect((await victim.list()).records.every((r) => r.id !== "forge_1")).toBe(true);

      // The forged tag only ever sees its own record.
      expect((await forger.get("forge_1"))?.data).toEqual({ intent: "escape" });
    });
  });
}
