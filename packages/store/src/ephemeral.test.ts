import { auditEventSchema, permissionGrantSchema, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, approvalFixture, at, auditFixture, grantFixture, persistentPrincipal } from "./fixtures.test-util.js";
import {
  appStore,
  approvalStore,
  auditStore,
  createStore,
  grantStore,
  registerEphemeralSubject,
  runStore,
  stateStore,
  sweepEphemeralSubjects,
  threadStore,
} from "./index.js";

// Kill-list B3: ephemeral (anonymous) principals write ORDINARY disk rows under
// their subject — the in-memory overlay is gone. Lifetime is the TTL sweep
// (sweepEphemeralSubjects) or adoption, not process memory.
for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    const ephemeral: Principal = { kind: "user", subject: "sess_x", ephemeral: true };

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("serves ephemeral app, state, thread, grant, and audit writes through the single disk path", async () => {
      // The caller (the umbrella, per request) registers the session; data
      // writes do not depend on it, the sweep does.
      await registerEphemeralSubject(made.store, ephemeral.subject);
      const doc = appFixture("app_ephemeral", "Ephemeral");
      const grant = grantFixture("grt_ephemeral", { subject: ephemeral.subject, appId: doc.id });
      const event = auditFixture("aud_ephemeral", { principal: ephemeral, appId: doc.id });
      await appStore(made.store).put(ephemeral, doc);
      await stateStore(made.store).put(ephemeral, doc.id, { transient: true });
      await threadStore(made.store).put(ephemeral, { id: "thr_ephemeral", messages: [{ text: "temporary" }] });
      await grantStore(made.store).create(ephemeral, grant);
      await auditStore(made.store).append(event);
      const approval = approvalFixture("apr_ephemeral", {
        ctx: { principal: ephemeral, venue: "chat", presence: "present", appId: doc.id },
      });
      await approvalStore(made.store).create(approval);
      await runStore(made.store).put({
        id: "run_ephemeral",
        appId: doc.id,
        trigger: { kind: "schedule" },
        status: "running",
        record: { transient: true },
        startedAt: at(50),
      });
      const records = made.store.records("app:app_ephemeral:notes");
      await records.put({ id: "note_a", data: { text: "temporary a" }, refs: { kind: "note" } });
      await records.put({ id: "note_b", data: { text: "temporary b" }, refs: { kind: "note" } });
      const blobs = made.store.blobs("app:app_ephemeral:files");
      await blobs.put("z-last.txt", new Uint8Array([2]), { contentType: "text/plain" });
      await blobs.put("a-first.txt", new Uint8Array([1]));

      expect((await appStore(made.store).get(doc.id))?.doc).toEqual(doc);
      expect(await stateStore(made.store).get(ephemeral, doc.id)).toEqual({ transient: true });
      expect((await threadStore(made.store).get(ephemeral, "thr_ephemeral"))?.messages).toEqual([{ text: "temporary" }]);
      expect(permissionGrantSchema.parse(await grantStore(made.store).get(grant.id))).toEqual(grant);
      expect(auditEventSchema.parse((await auditStore(made.store).query({ principal: ephemeral })).events[0])).toEqual(event);
      expect((await approvalStore(made.store).pending(ephemeral)).map((request) => request.id)).toEqual(["apr_ephemeral"]);
      expect(await runStore(made.store).get("run_ephemeral")).toMatchObject({ appId: doc.id, status: "running" });
      expect((await records.get("note_a"))?.data).toEqual({ text: "temporary a" });
      // Returned objects are the caller's copies: mutating them never corrupts the store.
      const fetchedRecord = await records.get("note_a");
      (fetchedRecord?.data as { text: string }).text = "mutated after get";
      expect((await records.get("note_a"))?.data).toEqual({ text: "temporary a" });

      const listedRecord = (await records.list({ ids: ["note_a"] })).records[0];
      (listedRecord?.data as { text: string }).text = "mutated after list";
      expect((await records.get("note_a"))?.data).toEqual({ text: "temporary a" });

      const firstPage = await records.list({ refs: { kind: "note" }, limit: 1 });
      expect(firstPage.records).toHaveLength(1);
      expect(firstPage.cursor).toBeDefined();
      const secondPage = await records.list({ refs: { kind: "note" }, limit: 1, cursor: firstPage.cursor });
      expect(new Set([...firstPage.records, ...secondPage.records].map((record) => record.id)))
        .toEqual(new Set(["note_a", "note_b"]));
      expect(secondPage.cursor).toBeUndefined();
      expect(await blobs.list()).toEqual(["a-first.txt", "z-last.txt"]);
      expect(await blobs.get("z-last.txt")).toEqual({ bytes: new Uint8Array([2]), contentType: "text/plain" });
      const fetchedBlob = await blobs.get("z-last.txt");
      if (fetchedBlob) fetchedBlob.bytes[0] = 9;
      expect(await blobs.get("z-last.txt")).toEqual({ bytes: new Uint8Array([2]), contentType: "text/plain" });

      const routedGrants = made.store.records("vendo_grants");
      const routedGrant = grantFixture("grt_ephemeral_routed_snapshot", {
        subject: ephemeral.subject,
        appId: doc.id,
      });
      const routedPut = await routedGrants.put({ id: routedGrant.id, data: routedGrant });
      (routedPut.data as { tool: string }).tool = "mutated after put";
      expect((await routedGrants.get(routedGrant.id))?.data).toEqual(routedGrant);
      const routedGet = await routedGrants.get(routedGrant.id);
      (routedGet?.data as { tool: string }).tool = "mutated after get";
      expect((await routedGrants.get(routedGrant.id))?.data).toEqual(routedGrant);
    });

    it("writes ephemeral subject rows to the SQL tables like any durable subject (kill-list B3)", async () => {
      for (const table of ["vendo_apps", "vendo_state", "vendo_threads", "vendo_grants", "vendo_audit", "vendo_approvals"]) {
        const rows = await made.sql(`SELECT COUNT(*)::int AS count FROM ${table} WHERE subject = $1`, [ephemeral.subject]);
        expect(Number(rows[0]?.count), table).toBeGreaterThan(0);
      }
      const runs = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
        ["app_ephemeral"],
      );
      expect(Number(runs[0]?.count), "vendo_runs").toBe(1);
      const records = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_records WHERE collection = $1",
        ["app:app_ephemeral:notes"],
      );
      expect(Number(records[0]?.count), "vendo_records").toBe(2);
      const blobs = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = $1",
        ["app:app_ephemeral:files"],
      );
      expect(Number(blobs[0]?.count), "vendo_blobs").toBe(2);
      const session = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_sessions WHERE subject = $1",
        [ephemeral.subject],
      );
      expect(Number(session[0]?.count), "vendo_sessions").toBe(1);
    });

    it("does not disturb persistent rows", async () => {
      const doc = appFixture("app_persistent", "Persistent");
      const grant = grantFixture("grt_persistent", { appId: doc.id, grantedAt: at(15) });
      await appStore(made.store).put(persistentPrincipal, doc);
      await grantStore(made.store).create(persistentPrincipal, grant);
      expect((await made.sql("SELECT subject FROM vendo_apps WHERE id = $1", [doc.id]))[0]?.subject).toBe("user_test");
      expect((await grantStore(made.store).get(grant.id))?.id).toBe(grant.id);
    });

    it("keeps ephemeral rows across close/reopen until the TTL sweep erases them", async () => {
      // The session and its rows are disk state now: a restart loses nothing.
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir });
      await made.store.ensureSchema();
      expect((await appStore(made.store).get("app_ephemeral"))?.subject).toBe(ephemeral.subject);
      expect((await grantStore(made.store).get("grt_ephemeral"))?.id).toBe("grt_ephemeral");
      expect((await threadStore(made.store).get(ephemeral, "thr_ephemeral"))?.subject).toBe(ephemeral.subject);

      // The sweep is what ends the session: every row of the idle subject goes.
      const evicted = await sweepEphemeralSubjects(made.store, { idleMs: 1, now: Date.now() + 60_000 });
      expect(evicted).toEqual([ephemeral.subject]);
      expect(await appStore(made.store).get("app_ephemeral")).toBeNull();
      expect(await grantStore(made.store).get("grt_ephemeral")).toBeNull();
      expect(await threadStore(made.store).get(ephemeral, "thr_ephemeral")).toBeNull();
      expect(await made.store.records("app:app_ephemeral:notes").get("note_a")).toBeNull();
      expect(await made.store.blobs("app:app_ephemeral:files").get("z-last.txt")).toBeNull();
      expect(await runStore(made.store).get("run_ephemeral")).toBeNull();
      expect(await approvalStore(made.store).get("apr_ephemeral")).toBeNull();
      // Durable subjects are untouched by the sweep.
      expect(await appStore(made.store).get("app_persistent")).not.toBeNull();
      expect(await grantStore(made.store).get("grt_persistent")).not.toBeNull();
    });
  });
}
