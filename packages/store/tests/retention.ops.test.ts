import { engineAppHistory, type IsoDateTime, type StoreOps } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { auditFixture } from "../src/fixtures.test-util.js";
import { createStoreOps, eraseStore, storeFiles } from "../src/index.js";

const soon = (): IsoDateTime => new Date(Date.now() + 60_000).toISOString() as IsoDateTime;
const EPOCH = new Date(0).toISOString() as IsoDateTime;

// 01 §12 `StoreOps.retention` against the LOCAL engine. The shared conformance
// suite already holds the counts and the re-runs (core's storeOpsConformance);
// what lives here is what only this backend can be asked: that the sweep
// reaches a TYPED door's table, that the rows it lifts are still reachable by
// the erase cascade, and that the two collections whose rows are not the whole
// of what they own are refused rather than half-swept.
for (const backend of backends()) {
  describe(`${backend.name} StoreOps retention`, () => {
    let made: MadeBackend;
    let ops: StoreOps;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      ops = createStoreOps(made.store);
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("sweeps a typed door's own table — the audit drawer, which no door may delete from", async () => {
      // The append-only refusal is the point: `engine.delete` will not take an
      // audit row (02 §5), so before this family the ONLY ways out were the
      // erase cascade and the host's own SQL. A retention window is the third,
      // and it has to reach the real table, not a generic-row copy of it.
      const old = auditFixture("aud_ret_old", { at: "2020-01-01T00:00:00.000Z" });
      const fresh = auditFixture("aud_ret_fresh", { at: "2026-08-01T00:00:00.000Z" });
      for (const event of [old, fresh]) await ops.engine.put("vendo_audit", { id: event.id, data: event });

      const swept = await ops.retention!.quarantine("vendo_audit", "2025-01-01T00:00:00.000Z" as IsoDateTime);
      expect(swept.moved).toBe(1);
      expect(await ops.engine.get("vendo_audit", "aud_ret_old")).toBeNull();
      expect(await ops.engine.get("vendo_audit", "aud_ret_fresh")).not.toBeNull();
      // Lifted, not destroyed: the row is out of the live table and still in
      // the store until a purge says otherwise — the whole difference between
      // this and a DELETE.
      const held = await made.sql(
        "SELECT collection, data FROM vendo_quarantine WHERE id = $1",
        ["aud_ret_old"],
      );
      expect(held).toHaveLength(1);
      expect(held[0]?.collection).toBe("vendo_audit");
      // VERBATIM: the whole live row, so a restore has everything it took.
      expect(held[0]?.data).toMatchObject({ id: "aud_ret_old", kind: "tool-call", subject: "user_test" });

      expect((await ops.retention!.purge("vendo_audit", soon())).purged).toBe(1);
      expect(await made.sql("SELECT 1 FROM vendo_quarantine WHERE id = $1", ["aud_ret_old"])).toHaveLength(0);
    });

    it("erases a quarantined row with its subject", async () => {
      // A sweep must never be a way for data to outlive an erasure. The row is
      // in the quarantine, not in any collection, so only the columns the lift
      // copied off it can reach it.
      const leaver = "user_ret_erased";
      const event = auditFixture("aud_ret_erased", {
        principal: { kind: "user", subject: leaver },
        appId: "app_ret_erased",
      });
      await ops.engine.put("vendo_audit", { id: event.id, data: event });
      expect((await ops.retention!.quarantine("vendo_audit", soon())).moved).toBeGreaterThanOrEqual(1);
      expect(await made.sql("SELECT 1 FROM vendo_quarantine WHERE subject = $1", [leaver])).toHaveLength(1);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).bySubject(leaver);
      expect(report.vendo_quarantine).toBe(1);
      expect(await made.sql("SELECT 1 FROM vendo_quarantine WHERE subject = $1", [leaver])).toHaveLength(0);
    });

    it("erases a quarantined app-history row with its app", async () => {
      // The app-history drawer carries its app in the collection NAME and its
      // rows carry no refs at all — the same blind spot that once hid the
      // version log from the by-app cascade. In quarantine it is the collection
      // column that has to be matched.
      const appId = "app_ret_history";
      const collection = engineAppHistory(appId);
      await ops.engine.put(collection, { id: "ver_1", data: { version: 1 } });
      expect((await ops.retention!.quarantine(collection, soon())).moved).toBe(1);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).byApp(appId);
      expect(report.vendo_quarantine).toBe(1);
      expect(await made.sql("SELECT 1 FROM vendo_quarantine WHERE collection = $1", [collection])).toHaveLength(0);
    });

    it("refuses the collections whose rows are not the whole of what they own", async () => {
      // Lifting the row alone would strand the rest in the live database with
      // nothing left pointing at it: a thread's transcript and harness state,
      // an app's entire drawer, an automation's runs (which name it and
      // nothing else, so the erase cascade reaches them only through it).
      // Refused on BOTH verbs, so a caller cannot learn one answer from
      // `quarantine` and another from `purge`.
      for (const collection of ["vendo_threads", "vendo_apps", "vendo_automations"]) {
        await expect(ops.retention!.quarantine(collection, soon())).rejects.toMatchObject({ code: "blocked" });
        await expect(ops.retention!.purge(collection, soon())).rejects.toMatchObject({ code: "blocked" });
      }
      // ...and a collection that was never an engine collection is refused by
      // the same gate every other family is behind.
      await expect(ops.retention!.quarantine("host_invoices", soon())).rejects.toMatchObject({ code: "blocked" });
    });

    it("leaves harness continuity alone — the tenant of vendo_state its door cannot see", async () => {
      // `vendo_state` holds two things: an app's own state, keyed
      // `app_<id>:<subject>`, which the routed door addresses — and harness
      // CONTINUITY under `harness_state:<threadId>`, which reaches the table
      // only through ops.harness and belongs to a thread that is still alive.
      // A caller sweeping the collection names the first and cannot even see
      // the second, so lifting it would take a live conversation's session
      // away with nothing in the request that asked for it.
      await ops.transcripts.putThread({
        id: "thr_ret_live",
        subject: "user_ret_live",
        messages: [{ id: "m1", role: "user" }],
      });
      await ops.harness.set("harness_state:thr_ret_live", "user_ret_live", { session: "native_42" });
      await ops.harness.set("app_ret_live", "user_ret_live", { count: 1 });

      const swept = await ops.retention!.quarantine("vendo_state", soon());

      expect(swept.moved).toBe(1);
      expect(await ops.harness.get("app_ret_live", "user_ret_live")).toBeNull();
      expect(await ops.harness.get("harness_state:thr_ret_live", "user_ret_live"))
        .toEqual({ session: "native_42" });
      expect(await made.sql("SELECT id FROM vendo_quarantine WHERE collection = 'vendo_state'"))
        .toEqual([{ id: "app_ret_live:user_ret_live" }]);
    });

    it("keeps a purge inside one collection, and inside its own grace", async () => {
      const mine = engineAppHistory("app_ret_mine");
      const theirs = engineAppHistory("app_ret_theirs");
      await ops.engine.put(mine, { id: "ver_1", data: {} });
      await ops.engine.put(theirs, { id: "ver_1", data: {} });
      expect((await ops.retention!.quarantine(mine, soon())).moved).toBe(1);
      expect((await ops.retention!.quarantine(theirs, soon())).moved).toBe(1);

      // Still inside the grace: a purge cutoff that predates the lift destroys
      // nothing, which is the only place "still recoverable" is observable.
      expect((await ops.retention!.purge(mine, EPOCH)).purged).toBe(0);
      expect((await ops.retention!.purge(mine, soon())).purged).toBe(1);
      // The other collection's quarantine is untouched by a purge of this one.
      expect(await made.sql("SELECT 1 FROM vendo_quarantine WHERE collection = $1", [theirs])).toHaveLength(1);
    });
  });
}
