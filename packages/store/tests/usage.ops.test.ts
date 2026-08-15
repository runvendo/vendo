import type { IsoDateTime, StoreOps } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { createStoreOps, eraseStore, storeFiles } from "../src/index.js";

/** One instant inside a fixed hour, so a window can be drawn around it to the
 *  minute — which is the whole reason the meter stores events and not buckets. */
const at = (minute: number): Date => new Date(Date.UTC(2026, 7, 15, 10, minute));

// 01 §12 `StoreOps.usage` against the LOCAL engine. The shared conformance suite
// holds the roundtrip, the window edges and the grouping (core's
// storeOpsConformance); what lives here is what only this backend can be asked:
// that a recorded action really lands as a `vendo_usage` row, that the erase
// cascade takes those rows with their subject, and that a retention sweep
// cannot reach the drawer a limit is counted from.
for (const backend of backends()) {
  describe(`${backend.name} StoreOps usage`, () => {
    let made: MadeBackend;
    let ops: StoreOps;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      ops = createStoreOps(made.store);
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("records one row per metered action and counts them back", async () => {
      const subject = "user_meter_count";
      await ops.usage!.record({ subject, action: "message", at: at(0) });
      await ops.usage!.record({ subject, action: "message", at: at(1) });
      await ops.usage!.record({ subject, action: "generation", at: at(2) });

      // Events, not a counter: three rows, each keeping its own instant.
      const rows = await made.sql("SELECT action, at FROM vendo_usage WHERE subject = $1 ORDER BY at", [subject]);
      expect(rows).toHaveLength(3);

      expect(await ops.usage!.count({ subject, action: "message", since: at(0) })).toBe(2);
      expect(await ops.usage!.count({ subject, action: "generation", since: at(0) })).toBe(1);
      // Another person's meter is not this one's.
      expect(await ops.usage!.count({ subject: "user_meter_other", action: "message", since: at(0) })).toBe(0);
    });

    it("takes `since` inclusively and `until` exclusively", async () => {
      // audit.tally's floor is `at >= from`, and this window's floor is the same
      // one: two reads of the same drawer that disagree about an edge disagree
      // about a limit, and the person on the wrong side of it cannot tell why.
      const subject = "user_meter_window";
      for (const minute of [10, 11, 12]) {
        await ops.usage!.record({ subject, action: "message", at: at(minute) });
      }
      const window = { subject, action: "message" } as const;
      expect(await ops.usage!.count({ ...window, since: at(11) })).toBe(2);
      expect(await ops.usage!.count({ ...window, since: at(10), until: at(12) })).toBe(2);
      expect(await ops.usage!.count({ ...window, since: at(11), until: at(11) })).toBe(0);
      expect(await ops.usage!.count({ ...window, since: at(13) })).toBe(0);
    });

    it("counts a pool by matching any one of the keys the row was written with", async () => {
      // The keys are copied off the user at write time, so a member who leaves
      // never retroactively drains the team's quota — the row is the only place
      // that membership was ever true.
      await ops.usage!.record({ subject: "user_pool_a", action: "message", at: at(20), poolKeys: ["team_ops", "org_acme"] });
      await ops.usage!.record({ subject: "user_pool_b", action: "message", at: at(21), poolKeys: ["org_acme"] });
      await ops.usage!.record({ subject: "user_pool_c", action: "message", at: at(22) });

      expect(await ops.usage!.count({ poolKey: "org_acme", action: "message", since: at(20) })).toBe(2);
      expect(await ops.usage!.count({ poolKey: "team_ops", action: "message", since: at(20) })).toBe(1);
      expect(await ops.usage!.count({ poolKey: "team_absent", action: "message", since: at(20) })).toBe(0);
      // A pool count is the bucket's, never the members' own rows.
      expect(await ops.usage!.count({ subject: "user_pool_a", action: "message", since: at(20) })).toBe(1);
    });

    it("tallies a window per subject and action", async () => {
      const since = at(30);
      await ops.usage!.record({ subject: "user_tally_b", action: "message", at: at(30) });
      await ops.usage!.record({ subject: "user_tally_b", action: "message", at: at(31) });
      await ops.usage!.record({ subject: "user_tally_a", action: "generation", at: at(32) });

      const rows = (await ops.usage!.tally({ since })).filter((row) => row.subject.startsWith("user_tally_"));
      expect(rows).toEqual([
        { subject: "user_tally_a", action: "generation", count: 1 },
        { subject: "user_tally_b", action: "message", count: 2 },
      ]);
      expect(await ops.usage!.tally({ since, subject: "user_tally_a" }))
        .toEqual([{ subject: "user_tally_a", action: "generation", count: 1 }]);
      expect(await ops.usage!.tally({ since, action: "generation" }))
        .toEqual([{ subject: "user_tally_a", action: "generation", count: 1 }]);
    });

    it("erases a person's meter rows with the rest of their data", async () => {
      const leaver = "user_meter_erased";
      await ops.usage!.record({ subject: leaver, action: "message", at: at(40) });
      expect(await made.sql("SELECT 1 FROM vendo_usage WHERE subject = $1", [leaver])).toHaveLength(1);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).bySubject(leaver);
      expect(report.vendo_usage).toBe(1);
      expect(await made.sql("SELECT 1 FROM vendo_usage WHERE subject = $1", [leaver])).toHaveLength(0);
    });

    it("refuses a retention sweep of the meter", async () => {
      // The meter is not a collection anyone may name: it has no door, so the
      // engine gate that fences every collection-addressed verb refuses it, and
      // a limit can never be reset by ageing its evidence out.
      const soon = new Date(Date.now() + 60_000).toISOString() as IsoDateTime;
      await expect(ops.retention!.quarantine("vendo_usage", soon)).rejects.toMatchObject({ code: "blocked" });
      await expect(ops.retention!.purge("vendo_usage", soon)).rejects.toMatchObject({ code: "blocked" });
    });
  });
}
