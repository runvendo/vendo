import { createAppHistory } from "@vendoai/apps";
import { describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { eraseStore } from "../src/erase.js";
import { createStoreOps } from "../src/index.js";
import { storeFiles } from "../src/files-store.js";
import { appFixture } from "../src/fixtures.test-util.js";

/** 02-store §5 — the byApp cascade against a REAL apps-block writer. The capped
    version log used to slip through it and outlive its app forever: its name is
    not the `app:<id>:` prefix and its rows carry no refs at all. It is exercised
    end to end — written through the producer, erased through the consumer, read
    back through the producer — because a test that forges the rows itself can
    only ever agree with whatever the cascade happens to match. */

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
        const history = createAppHistory(engineFor(made));
        for (const doc of [target, bystander]) {
          await history.append(doc.id, doc, {
            at: "2026-01-02T03:04:05.000Z",
            intent: "first draft",
            rung: 1,
          });
        }

        expect((await erase(made, target.id)).vendo_records).toBe(1);

        expect(await history.documents(bystander.id)).toHaveLength(1);
      } finally {
        await made.cleanup();
      }
    });
  });
}
