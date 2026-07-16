import { VendoError, type Principal } from "@vendoai/core";
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
      // ENG-237 (STORE-1): the near-miss app-scoped collection needs a durable
      // owning app; routing (generic vendo_records, not the dedicated table) is
      // what this asserts and is unchanged.
      await appStore(made.store).put(persistentPrincipal, appFixture("app_x"));
      await made.store.records("vendo_state2").put({ id: "row_a", data: { n: 1 } });
      await made.store.records("app:app_x:vendo_state").put({ id: "row_b", data: { n: 2 } });
      expect(await made.sql(
        "SELECT collection FROM vendo_records WHERE id IN ('row_a', 'row_b') ORDER BY collection",
      )).toEqual([{ collection: "app:app_x:vendo_state" }, { collection: "vendo_state2" }]);
      // ...and none of it reached the dedicated table.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_x'",
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
  describe(`${backend.name} vendo_state id + created_at (M6/C1)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("keeps createdAt stable across two puts while updatedAt advances", async () => {
      const state = made.store.records("vendo_state");
      const first = await state.put({ id: "app_stable:user_s", data: { v: 1 } });
      await new Promise<void>((r) => setTimeout(r, 5));
      const second = await state.put({ id: "app_stable:user_s", data: { v: 2 } });
      expect(second.createdAt).toBe(first.createdAt);
      expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));
      // The generated id column reads back through a point lookup (indexed, not seq scan).
      expect((await state.get("app_stable:user_s"))?.createdAt).toBe(first.createdAt);
      expect(await made.sql(
        "SELECT id FROM vendo_state WHERE id = $1", ["app_stable:user_s"],
      )).toEqual([{ id: "app_stable:user_s" }]);
    });

    it("both write doors (stateStore + routed seam) produce identical rows", async () => {
      const viaHelper = await stateStore(made.store);
      await viaHelper.put(persistentPrincipal, "app_doors", { same: true });
      const helperRow = (await made.sql(
        "SELECT id, app_id, subject, data FROM vendo_state WHERE id = $1",
        [`app_doors:${persistentPrincipal.subject}`],
      ))[0];
      // Overwrite through the seam; row shape (id/app_id/subject) is identical.
      await made.store.records("vendo_state").put({ id: `app_doors:${persistentPrincipal.subject}`, data: { same: true } });
      const seamRow = (await made.sql(
        "SELECT id, app_id, subject, data FROM vendo_state WHERE id = $1",
        [`app_doors:${persistentPrincipal.subject}`],
      ))[0];
      expect(seamRow).toEqual(helperRow);
    });

    it("does not skip an unvisited row when a later row is updated mid-sweep (cursor on created_at)", async () => {
      const state = made.store.records("vendo_state");
      // Three rows created oldest->newest so the newest pages first.
      for (const suffix of ["a", "b", "c"]) {
        await made.sql(
          `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
           VALUES ($1, $2, $3::jsonb, $4, $4)`,
          [`app_sweep_${suffix}`, "user_sweep", JSON.stringify({ s: suffix }), `2026-05-0${suffix === "a" ? 1 : suffix === "b" ? 2 : 3}T00:00:00.000Z`],
        );
      }
      // Page size 1: read the newest (c). Then TOUCH c (updated_at jumps to now).
      const page1 = await state.list({ refs: { subject: "user_sweep" }, limit: 1 });
      expect(page1.records.map((r) => r.id)).toEqual(["app_sweep_c:user_sweep"]);
      await state.put({ id: "app_sweep_c:user_sweep", data: { touched: true } });
      // Continue the sweep. Because we page on the STABLE created_at, b and a are
      // still reachable — an updated_at cursor would have skipped past them.
      const seen = [...page1.records.map((r) => r.id)];
      let cursor = page1.cursor;
      while (cursor !== undefined) {
        const next = await state.list({ refs: { subject: "user_sweep" }, limit: 1, cursor });
        seen.push(...next.records.map((r) => r.id));
        cursor = next.cursor;
      }
      expect(seen).toEqual([
        "app_sweep_c:user_sweep",
        "app_sweep_b:user_sweep",
        "app_sweep_a:user_sweep",
      ]);
    });

    it("routes id 'app_a:b:c' as appId app_a / subject b:c (first colon splits)", async () => {
      await made.store.records("vendo_state").put({ id: "app_a:b:c", data: { ok: 1 } });
      expect(await made.sql(
        "SELECT app_id, subject FROM vendo_state WHERE app_id = 'app_a'",
      )).toEqual([{ app_id: "app_a", subject: "b:c" }]);
    });

    it("rejects a state id whose first segment is not a colon-free app id (C1)", async () => {
      // Without the shape check, '<appId>:<subject>' is not uniquely decodable and
      // a doctored id could collide with another row (e.g. (app_x:y, z) vs
      // (app_x, y:z)). The write door refuses any non-app_ leading segment, so no
      // doctored id can ever target a row it does not own.
      await expect(made.store.records("vendo_state").put({ id: "notanapp:user", data: {} }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      await expect(made.store.records("vendo_state").delete("notanapp:user"))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      // Nothing was written under the doctored id.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE subject = 'user'",
      ))[0]?.["count"])).toBe(0);
    });

    it("rejects a state id with an empty subject or empty app segment (P2)", async () => {
      // "app_demo:" has an empty subject — a routed put would create a state row that
      // belongs to no principal. "app_:x" has an empty app segment (a degenerate id
      // the apps runtime never mints). Both are refused at the door.
      const state = made.store.records("vendo_state");
      await expect(state.put({ id: "app_demo:", data: { orphan: true } }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      await expect(state.put({ id: "app_:x", data: { degenerate: true } }))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      // Nothing landed for either doctored id.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id IN ('app_demo', 'app_')",
      ))[0]?.["count"])).toBe(0);
    });

    it("gives created_at a non-null default for a direct INSERT that omits it (Devin)", async () => {
      // The table map is public: a host can INSERT into vendo_state directly. created_at
      // is the pagination cursor, so a NULL there would break paging — the column
      // DEFAULTs to now().
      await made.sql(
        `INSERT INTO vendo_state (app_id, subject, data, updated_at)
         VALUES ('app_direct', 'user_direct', $1::jsonb, $2)`,
        [JSON.stringify({ direct: true }), "2026-06-01T00:00:00.000Z"],
      );
      expect((await made.sql(
        "SELECT created_at FROM vendo_state WHERE app_id = 'app_direct'",
      ))[0]?.["created_at"]).not.toBeNull();
    });

    it("repairs a pre-existing created_at column that has no default (P1)", async () => {
      // Databases that booted before the DEFAULT was introduced have the column
      // WITHOUT a default, and ADD COLUMN IF NOT EXISTS skips entirely when the
      // column already exists. Simulate that state, then confirm ensureSchema's
      // explicit SET DEFAULT repairs it on the next boot.
      await made.sql("ALTER TABLE vendo_state ALTER COLUMN created_at DROP DEFAULT");
      await made.store.ensureSchema();
      await made.sql(
        `INSERT INTO vendo_state (app_id, subject, data, updated_at)
         VALUES ('app_repair', 'user_repair', $1::jsonb, $2)`,
        [JSON.stringify({ repaired: true }), "2026-06-02T00:00:00.000Z"],
      );
      expect((await made.sql(
        "SELECT created_at FROM vendo_state WHERE app_id = 'app_repair'",
      ))[0]?.["created_at"]).not.toBeNull();
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

    it("registers the subject on stateStore.put so a later seam write cannot leak to disk (B2)", async () => {
      // The split-brain / disk-leak case: an ephemeral principal's FIRST write goes
      // through stateStore.put (not appStore.put), then the apps runtime writes the
      // same subject through the records seam. Both must stay in the overlay — zero
      // disk rows (02 §4: ephemeral principals never touch disk).
      const solo: Principal = { kind: "user", subject: "sess_b2", ephemeral: true };
      await stateStore(made.store).put(solo, "app_b2", { first: "helper" });
      // The seam write for the same subject now correctly sees it as ephemeral.
      await made.store.records("vendo_state").put({ id: "app_b2:sess_b2", data: { second: "seam" } });

      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE subject = 'sess_b2'",
      ))[0]?.["count"])).toBe(0);
      // Both doors read the SAME overlay value (no split-brain).
      expect(await stateStore(made.store).get(solo, "app_b2")).toEqual({ second: "seam" });
      expect((await made.store.records("vendo_state").get("app_b2:sess_b2"))?.data)
        .toEqual({ second: "seam" });
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

    // Force the store back to a pre-v2 recorded version so the NEXT ensureSchema
    // runs the version-gated backfill exactly once (02 §4: forward-only).
    const downgradeToV1 = async (): Promise<void> => {
      await made.sql("UPDATE vendo_meta SET value = '1'::jsonb WHERE key = 'schema_version'");
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir });
    };

    it("relocates colon-id legacy rows once, records v2, and never re-runs", async () => {
      // Simulate a pre-fix deployment: state written the old way into vendo_records.
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ('vendo_state', $1, $2::jsonb, $3::jsonb, $4, $4)`,
        ["app_legacy:user_old", JSON.stringify({ legacy: true }), JSON.stringify({ app_id: "app_legacy", subject: "user_old" }), "2026-01-02T03:04:05.000Z"],
      );
      await downgradeToV1();

      // The v1 -> v3 upgrade performs the (v2) backfill on the way through.
      await made.store.ensureSchema();
      expect((await made.sql("SELECT value FROM vendo_meta WHERE key = 'schema_version'"))[0]?.value).toBe(3);

      expect(await made.sql(
        "SELECT app_id, subject, data FROM vendo_state WHERE app_id = 'app_legacy'",
      )).toEqual([{ app_id: "app_legacy", subject: "user_old", data: { legacy: true } }]);
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_records WHERE collection = 'vendo_state'",
      ))[0]?.["count"])).toBe(0);
      // created_at is backfilled (from updated_at), so the seam exposes a real one.
      expect((await made.sql(
        "SELECT created_at FROM vendo_state WHERE app_id = 'app_legacy'",
      ))[0]?.["created_at"]).toBeDefined();
      // Visible through the seam its owner reads from.
      expect((await made.store.records("vendo_state").get("app_legacy:user_old"))?.data)
        .toEqual({ legacy: true });

      // Already on v2: a second run does not re-run the backfill.
      await made.store.ensureSchema();
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_legacy'",
      ))[0]?.["count"])).toBe(1);
    });

    it("preserves colon-less collection='vendo_state' rows — they are NOT destroyed", async () => {
      // A different legacy shape (no colon in id) must survive: the scoped DELETE
      // only removes rows the INSERT actually relocated (B3).
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ('vendo_state', $1, $2::jsonb, NULL, $3, $3)`,
        ["colonless_legacy", JSON.stringify({ keep: true }), "2026-01-02T03:04:05.000Z"],
      );
      await downgradeToV1();
      await made.store.ensureSchema();

      expect(await made.sql(
        "SELECT id, data FROM vendo_records WHERE collection = 'vendo_state' AND id = 'colonless_legacy'",
      )).toEqual([{ id: "colonless_legacy", data: { keep: true } }]);
      // ...and it was NOT misrouted into the dedicated table.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'colonless_legacy'",
      ))[0]?.["count"])).toBe(0);
    });

    it("leaves an empty-subject legacy row ('app_demo:') in vendo_records — never relocated (P2)", async () => {
      // The predicate requires a non-empty subject after the colon, so a legacy row
      // whose id would split to an empty subject is NOT relocated into a principal-less
      // dedicated row — it survives untouched in vendo_records.
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ('vendo_state', $1, $2::jsonb, NULL, $3, $3)`,
        ["app_demo:", JSON.stringify({ orphan: true }), "2026-01-02T03:04:05.000Z"],
      );
      await downgradeToV1();
      await made.store.ensureSchema();

      expect(await made.sql(
        "SELECT id, data FROM vendo_records WHERE collection = 'vendo_state' AND id = 'app_demo:'",
      )).toEqual([{ id: "app_demo:", data: { orphan: true } }]);
      // ...and no principal-less row was created in the dedicated table.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_state WHERE app_id = 'app_demo'",
      ))[0]?.["count"])).toBe(0);
    });

    it("resolves a newer legacy row over an older dedicated row by timestamp (C2)", async () => {
      // Both write doors were live pre-fix; a legacy vendo_records row can be NEWER
      // than an existing dedicated row. The newer write must win, not DO NOTHING.
      await made.sql(
        `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
         VALUES ('app_c2', 'user_c2', $1::jsonb, $2, $2)`,
        [JSON.stringify({ from: "dedicated-stale" }), "2026-02-01T00:00:00.000Z"],
      );
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ('vendo_state', 'app_c2:user_c2', $1::jsonb, NULL, $2, $2)`,
        [JSON.stringify({ from: "records-newer" }), "2026-03-01T00:00:00.000Z"],
      );
      await downgradeToV1();
      await made.store.ensureSchema();
      expect((await made.sql(
        "SELECT data FROM vendo_state WHERE app_id = 'app_c2'",
      ))[0]?.["data"]).toEqual({ from: "records-newer" });
    });

    it("keeps an older legacy row from clobbering a newer dedicated row (C2)", async () => {
      await made.sql(
        `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
         VALUES ('app_c2b', 'user_c2b', $1::jsonb, $2, $2)`,
        [JSON.stringify({ from: "dedicated-newer" }), "2026-04-01T00:00:00.000Z"],
      );
      await made.sql(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at)
         VALUES ('vendo_state', 'app_c2b:user_c2b', $1::jsonb, NULL, $2, $2)`,
        [JSON.stringify({ from: "records-stale" }), "2026-01-01T00:00:00.000Z"],
      );
      await downgradeToV1();
      await made.store.ensureSchema();
      expect((await made.sql(
        "SELECT data FROM vendo_state WHERE app_id = 'app_c2b'",
      ))[0]?.["data"]).toEqual({ from: "dedicated-newer" });
    });
  });
}
