import { readFileSync } from "node:fs";
import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { ERASE_TABLES, eraseStore } from "./erase.js";
import { appFixture, approvalFixture, auditFixture, grantFixture } from "./fixtures.test-util.js";
import { appStore, grantStore } from "./index.js";

// 02-store §5: "A store-level erase API ... erases by subject (full erasure),
// by app, or by age, cascading the matching data across all 13 tables, and is
// exposed on the umbrella. It is the only sanctioned deletion path for audit
// rows."

describe("02-store §5 — erase cascade covers the contract's table map", () => {
  it("keeps the erase table list identical to the §2 table map", () => {
    const contract = readFileSync(
      new URL("../../../docs/contracts/02-store.md", import.meta.url),
      "utf8",
    );
    const documented = [...contract.matchAll(/^\| `(vendo_[a-z_]+)` \|/gm)].map((match) => match[1]);
    expect(documented).toHaveLength(13);
    expect(documented).toEqual([...ERASE_TABLES]);
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

    it("erases an ephemeral subject's overlay rows (02 §4) all the same", async () => {
      const store = made.store;
      const anon: Principal = { kind: "user", subject: "anon_erase", ephemeral: true };
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

  describe(`${backend.name} 02-store §5 — erase by age`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("rejects a non-ISO cutoff", async () => {
      await expect(eraseStore(made.store).byAge("yesterday"))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
    });

    it("erases rows whose last activity predates the cutoff and spares fresh rows", async () => {
      const store = made.store;
      const subject = "user_erase_by_age";
      const old = "2020-01-01T00:00:00.000Z";
      const cutoff = "2020-06-01T00:00:00.000Z";

      // Rows whose timestamps the doors take from the data itself.
      const oldEvent = auditFixture("aud_age_old", { principal: { kind: "user", subject }, at: old });
      await store.records("vendo_audit").put({ id: oldEvent.id, data: oldEvent });
      const freshEvent = auditFixture("aud_age_fresh", { principal: { kind: "user", subject } });
      await store.records("vendo_audit").put({ id: freshEvent.id, data: freshEvent });
      const oldGrant = grantFixture("grt_age_old", { subject, grantedAt: old });
      await store.records("vendo_grants").put({ id: oldGrant.id, data: oldGrant });
      const freshGrant = grantFixture("grt_age_fresh", { subject });
      await store.records("vendo_grants").put({ id: freshGrant.id, data: freshGrant });

      // Rows the doors stamp with "now": seed, then age them the host way (raw SQL).
      await store.records("vendo_threads").put({ id: "thr_age_old", data: { subject, messages: [] } });
      await store.records("vendo_threads").put({ id: "thr_age_fresh", data: { subject, messages: [] } });
      await made.sql("UPDATE vendo_threads SET created_at = $1, updated_at = $1 WHERE id = 'thr_age_old'", [old]);
      await store.records("crm:notes").put({ id: "note_age_old", data: { body: "old" } });
      await store.records("crm:notes").put({ id: "note_age_fresh", data: { body: "fresh" } });
      await made.sql("UPDATE vendo_records SET created_at = $1, updated_at = $1 WHERE id = 'note_age_old'", [old]);
      // A stale secret row (the age axis reaches vendo_secrets too)...
      await made.sql(
        "INSERT INTO vendo_secrets (name, ciphertext, created_at) VALUES ('OLD_SECRET', 'v2:a:b:c', $1)",
        [old],
      );
      // ...but a ROTATED secret (old created_at, fresh updated_at — exactly what
      // secretStore.set stamps on rewrite) is recent activity and must survive.
      await made.sql(
        "INSERT INTO vendo_secrets (name, ciphertext, created_at, updated_at) VALUES ('ROTATED_SECRET', 'v2:d:e:f', $1, $2)",
        [old, "2026-01-01T00:00:00.000Z"],
      );

      const report = await eraseStore(store).byAge(cutoff);
      expect(report.vendo_audit).toBe(1);
      expect(report.vendo_grants).toBe(1);
      expect(report.vendo_threads).toBe(1);
      expect(report.vendo_records).toBe(1);
      expect(report.vendo_secrets).toBe(1);

      expect(await store.records("vendo_audit").get("aud_age_old")).toBeNull();
      expect(await store.records("vendo_grants").get("grt_age_old")).toBeNull();
      expect(await store.records("vendo_threads").get("thr_age_old")).toBeNull();
      expect(await store.records("crm:notes").get("note_age_old")).toBeNull();

      expect(await store.records("vendo_audit").get("aud_age_fresh")).not.toBeNull();
      expect(await store.records("vendo_grants").get("grt_age_fresh")).not.toBeNull();
      expect(await store.records("vendo_threads").get("thr_age_fresh")).not.toBeNull();
      expect(await store.records("crm:notes").get("note_age_fresh")).not.toBeNull();
      const secrets = await made.sql("SELECT name FROM vendo_secrets ORDER BY name");
      expect(secrets.map((row) => row.name)).toEqual(["ROTATED_SECRET"]);
    });

    it("never touches an unexpired standing grant granted before the cutoff's window ends", async () => {
      const store = made.store;
      // Granted long ago but expiring in the future: GREATEST(granted, revoked,
      // expires) is in the future, so the grant's lifecycle has not aged out.
      const grant = grantFixture("grt_age_active", {
        subject: "user_age_active",
        grantedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await store.records("vendo_grants").put({ id: grant.id, data: grant });
      const report = await eraseStore(store).byAge("2020-06-01T00:00:00.000Z");
      expect(report.vendo_grants).toBe(0);
      expect(await store.records("vendo_grants").get(grant.id)).not.toBeNull();
    });
  });
}
