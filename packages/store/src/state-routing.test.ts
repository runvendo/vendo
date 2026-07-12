import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, persistentPrincipal } from "./fixtures.test-util.js";
import { appStore, createStore, registerEphemeralSubject, stateStore } from "./index.js";

for (const backend of backends()) {
  describe(`${backend.name} vendo_state routing`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("routes records(vendo_state) writes into the dedicated table, not vendo_records", async () => {
      const state = made.store.records("vendo_state");
      const record = await state.put({
        id: "app_route:user-7",
        data: { count: 3 },
        refs: { subject: "ignored", app_id: "ignored" },
      });
      expect(record).toMatchObject({
        id: "app_route:user-7",
        data: { count: 3 },
        refs: { app_id: "app_route", subject: "user-7" },
      });

      // Lands in vendo_state with app_id + subject + data + updated_at populated.
      expect(await made.sql(
        "SELECT app_id, subject, data FROM vendo_state WHERE app_id = $1 AND subject = $2",
        ["app_route", "user-7"],
      )).toEqual([{ app_id: "app_route", subject: "user-7", data: { count: 3 } }]);
      expect((await made.sql(
        "SELECT updated_at FROM vendo_state WHERE app_id = $1 AND subject = $2",
        ["app_route", "user-7"],
      ))[0]?.["updated_at"]).toBeDefined();

      // Nothing leaked into the generic records table for this collection.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_records WHERE collection = 'vendo_state'",
      ))[0]?.["count"])).toBe(0);

      // get / list round-trip through the dedicated table.
      expect((await state.get("app_route:user-7"))?.data).toEqual({ count: 3 });
      expect((await state.list({ refs: { app_id: "app_route" } })).records.map((r) => r.id))
        .toEqual(["app_route:user-7"]);

      // update-in-place, then delete.
      await state.put({ id: "app_route:user-7", data: { count: 9 } });
      expect((await state.get("app_route:user-7"))?.data).toEqual({ count: 9 });
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_route'",
      ))[0]?.["count"])).toBe(1);
      await state.delete("app_route:user-7");
      expect(await state.get("app_route:user-7")).toBeNull();
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_route'",
      ))[0]?.["count"])).toBe(0);
    });

    it("splits the record id on the first colon so subjects may contain colons", async () => {
      const state = made.store.records("vendo_state");
      await state.put({ id: "app_123:user:with:colons", data: { ok: true } });
      expect(await made.sql(
        "SELECT app_id, subject FROM vendo_state WHERE app_id = $1",
        ["app_123"],
      )).toEqual([{ app_id: "app_123", subject: "user:with:colons" }]);
      expect((await state.get("app_123:user:with:colons"))?.data).toEqual({ ok: true });
    });

    it("leaves near-miss collection names in vendo_records", async () => {
      await made.store.records("vendo_state2").put({ id: "row_a", data: { n: 1 } });
      await made.store.records("app:x:vendo_state").put({ id: "row_b", data: { n: 2 } });
      expect(await made.sql(
        "SELECT collection FROM vendo_records WHERE id IN ('row_a', 'row_b') ORDER BY collection",
      )).toEqual([{ collection: "app:x:vendo_state" }, { collection: "vendo_state2" }]);
      // ...and none of it reached the dedicated table.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app:x'",
      ))[0]?.["count"])).toBe(0);
    });

    it("rejects a state id that has no colon", async () => {
      await expect(made.store.records("vendo_state").put({ id: "no_colon", data: {} }))
        .rejects.toMatchObject({ code: "validation" });
    });

    it("shares one world between stateStore and the records(vendo_state) seam", async () => {
      const seam = made.store.records("vendo_state");
      // helper write is visible through the seam
      await stateStore(made.store).put(persistentPrincipal, "app_shared", { via: "helper" });
      expect((await seam.get(`app_shared:${persistentPrincipal.subject}`))?.data).toEqual({ via: "helper" });
      // seam write is visible through the helper
      await seam.put({ id: `app_shared:${persistentPrincipal.subject}`, data: { via: "seam" } });
      expect(await stateStore(made.store).get(persistentPrincipal, "app_shared")).toEqual({ via: "seam" });
    });

    it("app-delete cascade removes runtime-written state", async () => {
      const doc = appFixture("app_cascade", "Cascade");
      await appStore(made.store).put(persistentPrincipal, doc);
      await made.store.records("vendo_state").put({
        id: `app_cascade:${persistentPrincipal.subject}`,
        data: { keep: false },
      });
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_cascade'",
      ))[0]?.["count"])).toBe(1);

      await appStore(made.store).delete(doc.id);
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_cascade'",
      ))[0]?.["count"])).toBe(0);
    });
  });
}

for (const backend of backends()) {
  describe(`${backend.name} vendo_state ephemeral routing`, () => {
    let made: MadeBackend;
    const ephemeral: Principal = { kind: "user", subject: "sess_state", ephemeral: true };

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("keeps routed state for an ephemeral subject off disk, then drops it on reopen", async () => {
      // Creating the app registers the subject as ephemeral (as apps' lifecycle does).
      await appStore(made.store).put(ephemeral, appFixture("app_ghost", "Ghost"));
      const seam = made.store.records("vendo_state");
      await seam.put({ id: "app_ghost:sess_state", data: { secret: 1 } });

      // Readable in-session...
      expect((await seam.get("app_ghost:sess_state"))?.data).toEqual({ secret: 1 });
      expect(await stateStore(made.store).get(ephemeral, "app_ghost")).toEqual({ secret: 1 });
      // ...but nothing hit the table.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE subject = $1",
        [ephemeral.subject],
      ))[0]?.["count"])).toBe(0);

      // Gone after reopen (overlay dropped, no disk row).
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir });
      await made.store.ensureSchema();
      expect(await made.store.records("vendo_state").get("app_ghost:sess_state")).toBeNull();
    });
  });
}

for (const backend of backends()) {
  describe(`${backend.name} vendo_state migration backfill`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("relocates legacy vendo_records state rows into the dedicated table", async () => {
      // Simulate a pre-fix deployment: state written the old way into vendo_records.
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ('vendo_state', $1, $2::jsonb, $3::jsonb, $4, $4)`,
        ["app_legacy:user_old", JSON.stringify({ legacy: true }), JSON.stringify({ app_id: "app_legacy", subject: "user_old" }), "2026-01-02T03:04:05.000Z"],
      );

      // Re-running ensureSchema performs the idempotent backfill.
      await made.store.ensureSchema();

      expect(await made.sql(
        "SELECT app_id, subject, data FROM vendo_state WHERE app_id = 'app_legacy'",
      )).toEqual([{ app_id: "app_legacy", subject: "user_old", data: { legacy: true } }]);
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_records WHERE collection = 'vendo_state'",
      ))[0]?.["count"])).toBe(0);
      // Visible through the seam its owner reads from.
      expect((await made.store.records("vendo_state").get("app_legacy:user_old"))?.data)
        .toEqual({ legacy: true });

      // Idempotent: a second run is a no-op.
      await made.store.ensureSchema();
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_legacy'",
      ))[0]?.["count"])).toBe(1);
    });
  });
}
