import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, at, grantFixture } from "./fixtures.test-util.js";
import { appStore, grantStore } from "./index.js";

// 02-store §2: the app row IS the user's copy and grants are subject-scoped —
// neither ever crosses subjects. Wave 3 gives vendo_apps and vendo_grants the
// same ATOMIC cross-subject flip refusal vendo_threads already has (the upsert
// updates only when the existing row belongs to the same subject; otherwise
// RETURNING is empty and the write is refused — no TOCTOU window).

const userA = "user_flip_a";
const userB = "user_flip_b";

for (const backend of backends()) {
  describe(`${backend.name} 02-store §2 — vendo_apps cross-subject flip refusal`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("refuses a routed put that would flip an app to another subject", async () => {
      const apps = made.store.records("vendo_apps");
      const doc = appFixture("app_flip_routed");
      await apps.put({ id: doc.id, data: { subject: userA, enabled: true, doc } });

      await expect(apps.put({ id: doc.id, data: { subject: userB, enabled: true, doc } }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect((await apps.get(doc.id))?.refs?.["subject"]).toBe(userA);
    });

    it("still updates the app for the owning subject", async () => {
      const apps = made.store.records("vendo_apps");
      const doc = appFixture("app_flip_same");
      await apps.put({ id: doc.id, data: { subject: userA, enabled: true, doc } });
      const updated = await apps.put({ id: doc.id, data: { subject: userA, enabled: false, doc } });
      expect((updated.data as { enabled: boolean }).enabled).toBe(false);
    });

    it("refuses the flip through the appStore helper door", async () => {
      const store = appStore(made.store);
      const doc = appFixture("app_flip_helper");
      await store.put({ kind: "user", subject: userA }, doc);

      await expect(store.put({ kind: "user", subject: userB }, doc))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect((await store.get(doc.id))?.subject).toBe(userA);
    });

    it("refuses the flip for ephemeral principals through the same disk path (kill-list B3)", async () => {
      const anonA: Principal = { kind: "user", subject: "anon_flip_a", ephemeral: true };
      const anonB: Principal = { kind: "user", subject: "anon_flip_b", ephemeral: true };
      const store = appStore(made.store);
      const doc = appFixture("app_flip_anon");
      await store.put(anonA, doc);

      await expect(store.put(anonB, doc))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });

      // The routed door refuses the same flip on the same disk row.
      const apps = made.store.records("vendo_apps");
      await expect(apps.put({ id: doc.id, data: { subject: anonB.subject, enabled: true, doc } }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect((await store.get(doc.id))?.subject).toBe(anonA.subject);
    });
  });

  describe(`${backend.name} 02-store §2 — vendo_grants cross-subject flip refusal`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("refuses a routed put that would flip a grant to another subject", async () => {
      const grants = made.store.records("vendo_grants");
      const grant = grantFixture("grt_flip_routed", { subject: userA });
      await grants.put({ id: grant.id, data: grant });

      const forged = grantFixture("grt_flip_routed", { subject: userB });
      await expect(grants.put({ id: forged.id, data: forged }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect((await grants.get(grant.id))?.refs?.["subject"]).toBe(userA);
    });

    it("still updates the grant for the owning subject (revocation path)", async () => {
      const grants = made.store.records("vendo_grants");
      const grant = grantFixture("grt_flip_same", { subject: userA });
      await grants.put({ id: grant.id, data: grant });

      const revoked = grantFixture("grt_flip_same", { subject: userA, revokedAt: at(40) });
      const updated = await grants.put({ id: revoked.id, data: revoked });
      expect((updated.data as { revokedAt?: string }).revokedAt).toBe(at(40));
    });

    it("refuses the flip for ephemeral principals through the same disk path (kill-list B3)", async () => {
      const anonA: Principal = { kind: "user", subject: "anon_grant_a", ephemeral: true };
      const anonB: Principal = { kind: "user", subject: "anon_grant_b", ephemeral: true };
      const store = grantStore(made.store);
      await store.create(anonA, grantFixture("grt_flip_anon", { subject: anonA.subject }));

      await expect(store.create(anonB, grantFixture("grt_flip_anon", { subject: anonB.subject })))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });

      // The routed door refuses the same flip on the same disk row.
      const grants = made.store.records("vendo_grants");
      const forged = grantFixture("grt_flip_anon", { subject: anonB.subject });
      await expect(grants.put({ id: forged.id, data: forged }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect((await store.get("grt_flip_anon"))?.subject).toBe(anonA.subject);
    });
  });
}
