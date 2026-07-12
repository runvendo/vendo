import { auditEventSchema, permissionGrantSchema, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture, at, auditFixture, grantFixture, persistentPrincipal } from "./fixtures.test-util.js";
import { appStore, auditStore, createStore, grantStore, stateStore, threadStore } from "./index.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    const ephemeral: Principal = { kind: "user", subject: "sess_x", ephemeral: true };

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("serves ephemeral app, state, thread, grant, and audit writes from memory", async () => {
      const doc = appFixture("app_ephemeral", "Ephemeral");
      const grant = grantFixture("grt_ephemeral", { subject: ephemeral.subject, appId: doc.id });
      const event = auditFixture("aud_ephemeral", { principal: ephemeral, appId: doc.id });
      await appStore(made.store).put(ephemeral, doc);
      await stateStore(made.store).put(ephemeral, doc.id, { transient: true });
      await threadStore(made.store).put(ephemeral, { id: "thr_ephemeral", messages: [{ text: "temporary" }] });
      await grantStore(made.store).create(ephemeral, grant);
      await auditStore(made.store).append(event);

      expect((await appStore(made.store).get(doc.id))?.doc).toEqual(doc);
      expect(await stateStore(made.store).get(ephemeral, doc.id)).toEqual({ transient: true });
      expect((await threadStore(made.store).get(ephemeral, "thr_ephemeral"))?.messages).toEqual([{ text: "temporary" }]);
      expect(permissionGrantSchema.parse(await grantStore(made.store).get(grant.id))).toEqual(grant);
      expect(auditEventSchema.parse((await auditStore(made.store).query({ principal: ephemeral })).events[0])).toEqual(event);
    });

    it("writes no ephemeral subject rows to any corresponding SQL table", async () => {
      for (const table of ["vendo_apps", "vendo_state", "vendo_threads", "vendo_grants", "vendo_audit"]) {
        const rows = await made.sql(`SELECT COUNT(*)::int AS count FROM ${table} WHERE subject = $1`, [ephemeral.subject]);
        expect(Number(rows[0]?.count), table).toBe(0);
      }
    });

    it("does not disturb persistent rows", async () => {
      const doc = appFixture("app_persistent", "Persistent");
      const grant = grantFixture("grt_persistent", { appId: doc.id, grantedAt: at(15) });
      await appStore(made.store).put(persistentPrincipal, doc);
      await grantStore(made.store).create(persistentPrincipal, grant);
      expect((await made.sql("SELECT subject FROM vendo_apps WHERE id = $1", [doc.id]))[0]?.subject).toBe("user_test");
      expect((await grantStore(made.store).get(grant.id))?.id).toBe(grant.id);
    });

    it("drops the overlay after close while preserving disk rows across reopen", async () => {
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir });
      await made.store.ensureSchema();
      expect(await appStore(made.store).get("app_ephemeral")).toBeNull();
      expect(await grantStore(made.store).get("grt_ephemeral")).toBeNull();
      expect(await threadStore(made.store).get(ephemeral, "thr_ephemeral")).toBeNull();
      expect(await appStore(made.store).get("app_persistent")).not.toBeNull();
      expect(await grantStore(made.store).get("grt_persistent")).not.toBeNull();
    });
  });
}
