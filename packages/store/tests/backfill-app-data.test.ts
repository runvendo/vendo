import { createAppTokens } from "@vendoai/apps";
import type { Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { reownAppData } from "../src/backfill-app-data.js";
import { appFixture } from "../src/fixtures.test-util.js";
import { appStore, backfillAppDataStamps, createStoreOps } from "../src/index.js";
import { dbFor } from "../src/store.js";

/** appData reads are auto-scoped to the caller's owner, so data written before
    a door moved onto the family is invisible until it is stamped. Every
    assertion here reads back through the REAL appData path — raw SQL only
    where a legacy row has to be forged, or where "untouched" is the claim. */

const dana: Principal = { kind: "user", subject: "dana" };

for (const backend of backends()) {
  describe(`${backend.name} appData backfill`, () => {
    const make = async (): Promise<MadeBackend> => {
      const made = await backend.make();
      await made.store.ensureSchema();
      return made;
    };

    /** Legacy rows: the pre-appData write path, which stamps nothing. */
    const seedLegacy = async (made: MadeBackend, collection: string, ids: string[]): Promise<void> => {
      const records = made.store.records(collection);
      for (const id of ids) await records.put({ id, data: { note: id } });
    };

    it("stamps a personal app's legacy rows so the scoped read sees them again, batch by batch", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_notes"));
        await seedLegacy(made, "app:app_notes:notes", ["n1", "n2", "n3", "n4", "n5"]);
        // Invisible before the backfill — the whole reason this exists.
        const ops = createStoreOps(made.store);
        const target = { appId: "app_notes", collection: "notes", owner: "dana" };
        expect((await ops.appData.list(target)).records).toEqual([]);

        // batch: 2 over 5 rows — three passes, the last one short.
        expect(await backfillAppDataStamps(made.store, { batch: 2 })).toEqual({
          apps: 1,
          rowsStamped: 5,
          rowsSkipped: 0,
          filesMoved: 0,
          orphanCollections: [],
        });

        expect((await ops.appData.list(target)).records.map((record) => record.id).sort())
          .toEqual(["n1", "n2", "n3", "n4", "n5"]);
        expect(await ops.appData.get(target, "n3")).toMatchObject({ data: { note: "n3" } });
      } finally {
        await made.cleanup();
      }
    });

    it("stamps a promoted app's rows with the ORG, not the subject that created them", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_team"));
        await appStore(made.store).promote("app_team", "dana", "acme");
        await seedLegacy(made, "app:app_team:notes", ["t1", "t2"]);

        expect(await backfillAppDataStamps(made.store)).toMatchObject({ apps: 1, rowsStamped: 2 });

        const ops = createStoreOps(made.store);
        const base = { appId: "app_team", collection: "notes" };
        expect((await ops.appData.list({ ...base, owner: "acme" })).records.map((r) => r.id).sort())
          .toEqual(["t1", "t2"]);
        // The org owns the app now (§9.5), so the old personal subject sees nothing.
        expect((await ops.appData.list({ ...base, owner: "dana" })).records).toEqual([]);
      } finally {
        await made.cleanup();
      }
    });

    it("re-runs to a no-op, leaving every row's content byte-identical", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_twice"));
        await seedLegacy(made, "app:app_twice:notes", ["a", "b", "c"]);
        // `data`, `revision` and `updated_at` must survive both runs untouched:
        // the row's content never changed, and a bumped revision would fail a
        // live CAS holder for a change it cannot see.
        const content = "SELECT id, data, revision, updated_at FROM vendo_records ORDER BY id";
        const before = await made.sql(content);

        expect(await backfillAppDataStamps(made.store)).toMatchObject({ rowsStamped: 3, rowsSkipped: 0 });
        expect(await backfillAppDataStamps(made.store)).toEqual({
          apps: 1,
          rowsStamped: 0,
          rowsSkipped: 3,
          filesMoved: 0,
          orphanCollections: [],
        });

        expect(await made.sql(content)).toEqual(before);
      } finally {
        await made.cleanup();
      }
    });

    it("reports a collection whose app is gone and touches nothing in it", async () => {
      const made = await make();
      try {
        // Forged directly: the live write path refuses an app-scoped row whose
        // app has no `vendo_apps` row, which is exactly what makes this legacy.
        for (const id of ["g1", "g2"]) {
          await made.sql(
            `INSERT INTO vendo_records (collection, id, data, created_at, updated_at)
             VALUES ($1, $2, $3, now(), now())`,
            ["app:app_ghost:notes", id, JSON.stringify({ note: id })],
          );
        }

        expect(await backfillAppDataStamps(made.store)).toEqual({
          apps: 0,
          rowsStamped: 0,
          rowsSkipped: 0,
          filesMoved: 0,
          orphanCollections: ["app:app_ghost:notes"],
        });

        expect(await made.sql(
          "SELECT id, data, refs FROM vendo_records WHERE collection = $1 ORDER BY id",
          ["app:app_ghost:notes"],
        )).toEqual([
          { id: "g1", data: { note: "g1" }, refs: null },
          { id: "g2", data: { note: "g2" }, refs: null },
        ]);
      } finally {
        await made.cleanup();
      }
    });

    /** `/` is what separates the owner leg from the caller's key, so an owner
        carrying one writes a file key another owner can read back — owner
        `own_a/sub` and owner `own_a`'s key `sub/x.bin` spell the same row.
        `vendo_apps.subject` is host-chosen, so that owner is reachable here; an
        owner this backfill cannot USE safely is reported exactly like one it
        cannot determine, because no later door fix can unbend data already
        written under an ambiguous key. */
    it("reports an app whose subject carries a slash, stamping nothing and moving nothing", async () => {
      const made = await make();
      try {
        await appStore(made.store).put({ kind: "user", subject: "own_a/sub" }, appFixture("app_slash"));
        await seedLegacy(made, "app:app_slash:notes", ["s1"]);
        await made.store.blobs("app:app_slash:docs").put("x.bin", new Uint8Array([1]));

        expect(await backfillAppDataStamps(made.store)).toEqual({
          apps: 0,
          rowsStamped: 0,
          rowsSkipped: 0,
          filesMoved: 0,
          orphanCollections: ["app:app_slash:notes", "app:app_slash:docs"],
        });

        expect(await made.sql("SELECT refs FROM vendo_records WHERE collection = $1", ["app:app_slash:notes"]))
          .toEqual([{ refs: null }]);
        expect(await made.sql("SELECT key FROM vendo_blobs WHERE namespace = $1", ["app:app_slash:docs"]))
          .toEqual([{ key: "x.bin" }]);
      } finally {
        await made.cleanup();
      }
    });

    it("re-keys legacy files under the owner leg exactly once", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_files"));
        const bytes = new TextEncoder().encode("quarterly numbers");
        // Legacy: written straight at the namespace, with no owner leg.
        await made.store.blobs("app:app_files:docs").put("report.txt", bytes, { contentType: "text/plain" });

        expect(await backfillAppDataStamps(made.store)).toMatchObject({ apps: 1, filesMoved: 1 });
        expect(await made.sql("SELECT key FROM vendo_blobs")).toEqual([{ key: "dana/report.txt" }]);

        // The owner leg is the seam's business, so the caller's key is the one
        // it always was.
        const ops = createStoreOps(made.store);
        const target = { appId: "app_files", collection: "docs", owner: "dana" };
        expect(await ops.appData.listFiles(target)).toEqual(["report.txt"]);
        const read = await ops.appData.getFile(target, "report.txt");
        expect(Buffer.from(read?.bytes ?? new Uint8Array()).toString("utf8")).toBe("quarterly numbers");

        expect(await backfillAppDataStamps(made.store)).toMatchObject({ filesMoved: 0 });
        expect(await made.sql("SELECT key FROM vendo_blobs")).toEqual([{ key: "dana/report.txt" }]);
      } finally {
        await made.cleanup();
      }
    });

    it("touches only the named app when scoped to one appId", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_a"));
        await appStore(made.store).put(dana, appFixture("app_b"));
        await seedLegacy(made, "app:app_a:notes", ["a1"]);
        await seedLegacy(made, "app:app_b:notes", ["b1"]);

        expect(await backfillAppDataStamps(made.store, { appId: "app_a" })).toEqual({
          apps: 1,
          rowsStamped: 1,
          rowsSkipped: 0,
          filesMoved: 0,
          orphanCollections: [],
        });

        expect(await made.sql(
          "SELECT collection, refs FROM vendo_records ORDER BY collection",
        )).toEqual([
          { collection: "app:app_a:notes", refs: { subject: "dana" } },
          { collection: "app:app_b:notes", refs: null },
        ]);
      } finally {
        await made.cleanup();
      }
    });

    /** Promote's half. The file statement rebuilds the key around a new owner
        leg, so the 1-indexed `substring` offset is proven here, not reasoned
        about: a wrong offset leaves a slash or eats a character. */
    it("reowns an app's rows and files when the app changes hands", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_reown"));
        const ops = createStoreOps(made.store);
        const owned = { appId: "app_reown", collection: "notes", owner: "dana" };
        await ops.appData.put(owned, { id: "r1", data: { note: "mine" } });
        await ops.appData.putFile(owned, "report.txt", new TextEncoder().encode("hi"));

        await reownAppData(dbFor(made.store), "app_reown", "dana", "acme");

        expect(await made.sql("SELECT key FROM vendo_blobs")).toEqual([{ key: "acme/report.txt" }]);
        const moved = { ...owned, owner: "acme" };
        expect((await ops.appData.list(moved)).records.map((record) => record.id)).toEqual(["r1"]);
        expect(await ops.appData.listFiles(moved)).toEqual(["report.txt"]);
        expect((await ops.appData.list(owned)).records).toEqual([]);
      } finally {
        await made.cleanup();
      }
    });

    /** The real verb, end to end. Both stamped and legacy rows have to arrive
        at the org: the backfill inside promote runs before the row flip, so the
        legacy row is stamped `dana` first and then renamed with the rest. */
    it("hands an app's rows and files to the org across a promote", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_hands"));
        const ops = createStoreOps(made.store);
        const mine = { appId: "app_hands", collection: "notes", owner: "dana" };
        await ops.appData.put(mine, { id: "stamped", data: { note: "mine" } });
        await seedLegacy(made, "app:app_hands:notes", ["legacy"]);
        await ops.appData.putFile(mine, "report.txt", new TextEncoder().encode("numbers"));

        await ops.lifecycle.promote("app_hands", "acme");

        const theirs = { ...mine, owner: "acme" };
        expect((await ops.appData.list(theirs)).records.map((record) => record.id).sort())
          .toEqual(["legacy", "stamped"]);
        // The owner leg is the seam's business, so the org reads the caller's
        // own key, unprefixed.
        expect(await ops.appData.listFiles(theirs)).toEqual(["report.txt"]);
        const read = await ops.appData.getFile(theirs, "report.txt");
        expect(Buffer.from(read?.bytes ?? new Uint8Array()).toString("utf8")).toBe("numbers");

        // The departed personal subject keeps nothing.
        expect((await ops.appData.list(mine)).records).toEqual([]);
        expect(await ops.appData.getFile(mine, "report.txt")).toBeNull();
        expect(await ops.appData.listFiles(mine)).toEqual([]);
      } finally {
        await made.cleanup();
      }
    });

    /** The seam, with no stub on either side: the producer is store's own
        `lifecycle.promote`, the consumer is apps' `verify`, which reads the
        subject straight off the token row's refs. A token left on the departed
        personal subject would have the box writing appData nobody owns. */
    it("moves the app token with the app, so the box's bearer verifies as the org", async () => {
      const made = await make();
      try {
        await appStore(made.store).put(dana, appFixture("app_bearer"));
        const token = await createAppTokens(createStoreOps(made.store).engine).mint("app_bearer", "dana");

        await createStoreOps(made.store).lifecycle.promote("app_bearer", "acme");

        expect(await createAppTokens(createStoreOps(made.store).engine).verify(token))
          .toEqual({ appId: "app_bearer", subject: "acme" });
      } finally {
        await made.cleanup();
      }
    });
  });
}
