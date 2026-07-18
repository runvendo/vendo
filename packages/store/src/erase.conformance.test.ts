import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { ERASE_TABLES, eraseStore } from "./erase.js";
import { DDL } from "./schema.js";
import { appFixture, approvalFixture, auditFixture, grantFixture } from "./fixtures.test-util.js";
import { appStore, grantStore, registerEphemeralSubject } from "./index.js";

// 02-store §5: "A store-level erase API ... erases by subject (full erasure)
// or by app, cascading the matching data across all 14 tables, and is
// exposed on the umbrella. It is the only sanctioned deletion path for audit
// rows."

describe("erase cascade covers the whole schema", () => {
  it("keeps ERASE_TABLES identical to the tables the schema actually creates", () => {
    // Code-to-code invariant (the retired contract doc used to proxy this):
    // every vendo_ table the DDL creates — plus vendo_meta, created in
    // migrate() — must be reachable by the erase cascade.
    const created = DDL
      .map((statement) => statement.match(/CREATE TABLE IF NOT EXISTS (vendo_[a-z_]+)/)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(new Set(ERASE_TABLES)).toEqual(new Set(["vendo_meta", ...created]));
  });
});

const seedRun = (appId: string): { id: string; data: Record<string, unknown> } => ({
  id: `run_${appId}`,
  data: {
    appId,
    trigger: { kind: "schedule" },
    status: "ok",
    record: { done: true },
    startedAt: "2026-01-02T03:04:50.000Z",
  },
});

for (const backend of backends()) {
  describe(`${backend.name} 02-store §5 — erase by subject`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("rejects an empty subject", async () => {
      await expect(eraseStore(made.store).bySubject(""))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
    });

    it("cascades one subject's data across the tables and spares everyone else", async () => {
      const store = made.store;
      const erased = "user_erase_target";
      const bystander = "user_erase_bystander";

      // Seed the target subject in every table the subject axis reaches.
      const doc = appFixture("app_erase_target");
      await store.records("vendo_apps").put({ id: doc.id, data: { subject: erased, enabled: true, doc } });
      await store.records(`app:${doc.id}:notes`).put({ id: "note_target", data: { body: "mine" } });
      await store.blobs(`app:${doc.id}:files`).put("report.txt", new Uint8Array([1, 2, 3]));
      await store.records("vendo_state").put({ id: `${doc.id}:${erased}`, data: { count: 1 } });
      await store.records("vendo_threads").put({
        id: "thr_erase_target",
        data: { subject: erased, messages: [] },
      });
      const grant = grantFixture("grt_erase_target", { subject: erased, appId: doc.id });
      await store.records("vendo_grants").put({ id: grant.id, data: grant });
      const request = approvalFixture("apr_erase_target", {
        ctx: { principal: { kind: "user", subject: erased }, venue: "chat", presence: "present", appId: doc.id },
      });
      await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      const event = auditFixture("aud_erase_target", { principal: { kind: "user", subject: erased } });
      await store.records("vendo_audit").put({ id: event.id, data: event });
      const run = seedRun(doc.id);
      await store.records("vendo_runs").put(run);
      await store.records("vendo_mcp_grants").put({
        id: "mcpg_erase_target",
        data: { kind: "family", status: "active" },
        refs: { subject: erased },
      });
      // A generic (non-app) collection row that carries the subject only as a ref.
      await store.records("door_sessions").put({
        id: "ds_erase_target",
        data: { open: true },
        refs: { subject: erased },
      });

      // Seed the bystander, who must survive untouched.
      const bystanderDoc = appFixture("app_erase_bystander");
      await store.records("vendo_apps").put({
        id: bystanderDoc.id,
        data: { subject: bystander, enabled: true, doc: bystanderDoc },
      });
      await store.records(`app:${bystanderDoc.id}:notes`).put({ id: "note_bystander", data: { body: "theirs" } });
      await store.records("vendo_threads").put({
        id: "thr_erase_bystander",
        data: { subject: bystander, messages: [] },
      });
      const bystanderEvent = auditFixture("aud_erase_bystander", { principal: { kind: "user", subject: bystander } });
      await store.records("vendo_audit").put({ id: bystanderEvent.id, data: bystanderEvent });

      const report = await eraseStore(store).bySubject(erased);
      expect(report).toEqual({
        vendo_meta: 0,
        vendo_apps: 1,
        vendo_records: 2, // the app's collection row + the subject-ref'd generic row
        vendo_blobs: 1,
        vendo_state: 1,
        vendo_threads: 1,
        vendo_grants: 1,
        vendo_approvals: 1,
        vendo_audit: 1,
        vendo_runs: 1,
        vendo_secrets: 0,
        vendo_mcp_clients: 0,
        vendo_mcp_grants: 1,
        vendo_sessions: 0, // durable subject — never registered as a session
      });

      // Gone through the doors...
      expect(await store.records("vendo_apps").get(doc.id)).toBeNull();
      expect(await store.records(`app:${doc.id}:notes`).get("note_target")).toBeNull();
      expect(await store.blobs(`app:${doc.id}:files`).get("report.txt")).toBeNull();
      expect(await store.records("vendo_threads").get("thr_erase_target")).toBeNull();
      expect(await store.records("vendo_audit").get(event.id)).toBeNull();
      // ...and gone from the host's own tables.
      const remaining = await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_audit WHERE subject = $1",
        [erased],
      );
      expect(Number(remaining[0]?.count)).toBe(0);

      // The bystander is untouched.
      expect(await store.records("vendo_apps").get(bystanderDoc.id)).not.toBeNull();
      expect(await store.records(`app:${bystanderDoc.id}:notes`).get("note_bystander")).not.toBeNull();
      expect(await store.records("vendo_threads").get("thr_erase_bystander")).not.toBeNull();
      expect(await store.records("vendo_audit").get(bystanderEvent.id)).not.toBeNull();
    });

    it("erases an ephemeral subject's rows and its session registration (02 §4) all the same", async () => {
      const store = made.store;
      const anon: Principal = { kind: "user", subject: "anon_erase", ephemeral: true };
      await registerEphemeralSubject(store, anon.subject);
      const doc = appFixture("app_erase_anon");
      await appStore(store).put(anon, doc);
      await store.records(`app:${doc.id}:notes`).put({ id: "note_anon", data: { body: "mine" } });
      await store.records("vendo_threads").put({ id: "thr_erase_anon", data: { subject: anon.subject, messages: [] } });
      await grantStore(store).create(anon, grantFixture("grt_erase_anon", { subject: anon.subject }));
      const event = auditFixture("aud_erase_anon", { principal: anon });
      await store.records("vendo_audit").put({ id: event.id, data: event });

      const report = await eraseStore(store).bySubject(anon.subject);
      expect(report.vendo_apps).toBe(1);
      expect(report.vendo_records).toBe(1);
      expect(report.vendo_threads).toBe(1);
      expect(report.vendo_grants).toBe(1);
      expect(report.vendo_audit).toBe(1);
      expect(report.vendo_sessions).toBe(1);

      expect(await appStore(store).get(doc.id)).toBeNull();
      expect(await store.records("vendo_threads").get("thr_erase_anon")).toBeNull();
      expect(await store.records("vendo_audit").get(event.id)).toBeNull();
      expect(await grantStore(store).get("grt_erase_anon")).toBeNull();
    });
  });

  describe(`${backend.name} 02-store §5 — erase by app`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("rejects an empty appId", async () => {
      await expect(eraseStore(made.store).byApp(""))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
    });

    it("erases one app's data and spares the subject's other app", async () => {
      const store = made.store;
      const subject = "user_erase_by_app";
      const seedApp = async (id: string): Promise<void> => {
        const doc = appFixture(id);
        await store.records("vendo_apps").put({ id, data: { subject, enabled: true, doc } });
        await store.records(`app:${id}:notes`).put({ id: `note_${id}`, data: { body: id } });
        await store.blobs(`app:${id}:files`).put("f.txt", new Uint8Array([7]));
        await store.records("vendo_state").put({ id: `${id}:${subject}`, data: { n: 1 } });
        await store.records("vendo_runs").put(seedRun(id));
        const grant = grantFixture(`grt_${id}`, { subject, appId: id });
        await store.records("vendo_grants").put({ id: grant.id, data: grant });
        const event = auditFixture(`aud_${id}`, { principal: { kind: "user", subject }, appId: id });
        await store.records("vendo_audit").put({ id: event.id, data: event });
      };
      await seedApp("app_erase_drop");
      await seedApp("app_erase_keep");
      await store.records("vendo_threads").put({
        id: "thr_erase_by_app",
        data: { subject, messages: [] },
      });

      const report = await eraseStore(store).byApp("app_erase_drop");
      expect(report.vendo_apps).toBe(1);
      expect(report.vendo_records).toBe(1);
      expect(report.vendo_blobs).toBe(1);
      expect(report.vendo_state).toBe(1);
      expect(report.vendo_runs).toBe(1);
      expect(report.vendo_grants).toBe(1);
      expect(report.vendo_audit).toBe(1);
      expect(report.vendo_threads).toBe(0); // no app axis (§2) — subject/age cover threads

      expect(await store.records("vendo_apps").get("app_erase_drop")).toBeNull();
      expect(await store.records("app:app_erase_drop:notes").get("note_app_erase_drop")).toBeNull();
      // The sibling app and the subject's thread survive.
      expect(await store.records("vendo_apps").get("app_erase_keep")).not.toBeNull();
      expect(await store.records("app:app_erase_keep:notes").get("note_app_erase_keep")).not.toBeNull();
      expect(await store.records("vendo_runs").get("run_app_erase_keep")).not.toBeNull();
      expect(await store.records("vendo_grants").get("grt_app_erase_keep")).not.toBeNull();
      expect(await store.records("vendo_audit").get("aud_app_erase_keep")).not.toBeNull();
      expect(await store.records("vendo_threads").get("thr_erase_by_app")).not.toBeNull();
    });
  });
}
