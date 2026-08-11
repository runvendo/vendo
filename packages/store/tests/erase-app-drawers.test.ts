import { createAppHistory, createInClientApprovals } from "@vendoai/apps";
import { describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { backfillAppRefKey } from "../src/backfill-app-data.js";
import { eraseStore } from "../src/erase.js";
import { createStoreOps } from "../src/index.js";
import { storeFiles } from "../src/files-store.js";
import { appFixture } from "../src/fixtures.test-util.js";

/** 02-store §5 — the byApp cascade against the REAL apps-block writers. Two
    drawers used to slip through it and outlive their app forever: the in-client
    approvals / remix rejections, whose rows carried the app under `refs.appId`
    while the cascade matches `app_id`, and the capped version log, whose name is
    not the `app:<id>:` prefix and whose rows carry no refs at all. Both halves
    are exercised end to end — written through the producer, erased through the
    consumer, read back through the producer — because a test that forges the
    rows itself can only ever agree with whatever the cascade happens to match. */

const SUBJECT = "user_erase_seam";

for (const backend of backends()) {
  describe(`${backend.name} byApp erase reaches the app's own drawers`, () => {
    const make = async (): Promise<MadeBackend> => {
      const made = await backend.make();
      await made.store.ensureSchema();
      return made;
    };

    const seedApp = async (made: MadeBackend, id: string) => {
      const doc = appFixture(id);
      await made.store.records("vendo_apps").put({
        id: doc.id,
        data: { subject: SUBJECT, enabled: true, doc },
      });
      return doc;
    };

    /** Vendo's own drawers are reached by name through the engine family, so
        the apps-block writers take that surface rather than the raw store. */
    const engineFor = (made: MadeBackend) => createStoreOps(made.store).engine;

    const erase = (made: MadeBackend, appId: string) =>
      eraseStore(made.store, { files: storeFiles(made.store) }).byApp(appId);

    it("takes an in-client approval written through the real approvals door, and counts it", async () => {
      const made = await make();
      try {
        const doc = await seedApp(made, "app_erase_inclient");
        const approvals = createInClientApprovals(engineFor(made));
        await approvals.record({
          appId: doc.id,
          versionHash: "sha256:seam",
          approvedBy: "host-console",
          at: "2026-01-02T03:04:05.000Z",
        });
        expect(await approvals.list(doc.id)).toHaveLength(1);

        const report = await erase(made, doc.id);

        expect(await approvals.list(doc.id)).toEqual([]);
        expect(await made.sql(
          "SELECT id FROM vendo_records WHERE collection = 'vendo_inclient_approvals'",
        )).toEqual([]);
        expect(report.vendo_records).toBe(1);
      } finally {
        await made.cleanup();
      }
    });

    it("takes the version log written through the real history door, and counts it", async () => {
      const made = await make();
      try {
        const doc = await seedApp(made, "app_erase_history");
        const history = createAppHistory(engineFor(made));
        await history.append(doc.id, doc, {
          at: "2026-01-02T03:04:05.000Z",
          intent: "first draft",
          rung: 1,
        });
        await history.append(doc.id, doc, {
          at: "2026-01-02T03:04:06.000Z",
          intent: "second draft",
          rung: 1,
        });
        expect(await history.documents(doc.id)).toHaveLength(2);

        const report = await erase(made, doc.id);

        expect(await history.documents(doc.id)).toEqual([]);
        expect(report.vendo_records).toBe(2);
      } finally {
        await made.cleanup();
      }
    });

    it("spares another app's drawers", async () => {
      const made = await make();
      try {
        const target = await seedApp(made, "app_erase_target");
        const bystander = await seedApp(made, "app_erase_bystander");
        const approvals = createInClientApprovals(engineFor(made));
        const history = createAppHistory(engineFor(made));
        for (const doc of [target, bystander]) {
          await approvals.record({
            appId: doc.id,
            versionHash: `sha256:${doc.id}`,
            approvedBy: "host-console",
            at: "2026-01-02T03:04:05.000Z",
          });
          await history.append(doc.id, doc, {
            at: "2026-01-02T03:04:05.000Z",
            intent: "first draft",
            rung: 1,
          });
        }

        expect((await erase(made, target.id)).vendo_records).toBe(2);

        expect(await approvals.list(bystander.id)).toHaveLength(1);
        expect(await history.documents(bystander.id)).toHaveLength(1);
      } finally {
        await made.cleanup();
      }
    });

    it("renames a legacy appId ref so the cascade can reach it, and reports zero on a second run", async () => {
      const made = await make();
      try {
        const doc = await seedApp(made, "app_erase_legacy");
        // The pre-fix writer's row, forged the only way it can be: the producer
        // no longer spells the key this way, and the whole point of the backfill
        // is the rows that are already on disk.
        await made.store.records("vendo_inclient_approvals").put({
          id: "incl_legacy",
          data: {
            appId: doc.id,
            versionHash: "sha256:legacy",
            approvedBy: "host-console",
            at: "2026-01-02T03:04:05.000Z",
          },
          refs: { appId: doc.id },
        });
        const approvals = createInClientApprovals(engineFor(made));
        // Invisible to the fixed reader until the key moves — the same shape of
        // failure the erase cascade had.
        expect(await approvals.list(doc.id)).toEqual([]);

        expect(await backfillAppRefKey(made.store)).toEqual({ rowsRenamed: 1, rowsSkipped: 0 });
        expect(await approvals.list(doc.id)).toHaveLength(1);
        // Idempotent: the second run finds nothing left to rename and reports
        // the row the first run fixed as already carrying the key.
        expect(await backfillAppRefKey(made.store)).toEqual({ rowsRenamed: 0, rowsSkipped: 1 });

        const report = await erase(made, doc.id);
        expect(report.vendo_records).toBe(1);
        expect(await approvals.list(doc.id)).toEqual([]);
      } finally {
        await made.cleanup();
      }
    });
  });
}
