import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { appFixture, approvalFixture, grantFixture } from "../fixtures.test-util.js";
import {
  adoptEphemeralSubject,
  appStore,
  approvalStore,
  grantStore,
  registerEphemeralSubject,
  stateStore,
  threadStore,
} from "../index.js";

const ANON: Principal = { kind: "user", subject: "anonymous_c0ffee", ephemeral: true };
const ADA: Principal = { kind: "user", subject: "user_ada" };

for (const backend of backends()) {
  describe(`adoptEphemeralSubject (${backend.name})`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("moves threads, apps (+ app collections), and state to the signed-in subject; drops grants/approvals; is idempotent", async () => {
      const store = made.store;
      await registerEphemeralSubject(store, ANON.subject);

      // Anonymous session accrues: an app, its per-app records, a thread, state, a grant, an approval.
      const apps = appStore(store);
      await apps.put(ANON, appFixture("app_anon_merge", "Anon app"));
      await store.records("app:app_anon_merge:notes").put({ id: "note_1", data: { text: "keep me" } });
      await threadStore(store).put(ANON, { id: "thr_anon_merge", messages: [{ role: "user" }] });
      await stateStore(store).put(ANON, "app_anon_merge", { count: 3 });
      await grantStore(store).create(ANON, grantFixture("grt_anon_merge", {
        subject: ANON.subject,
        appId: "app_anon_merge",
      }));
      await approvalStore(store).create(approvalFixture("apr_anon_merge", {
        ctx: { principal: ANON, venue: "chat", presence: "present" },
      }));

      const report = await adoptEphemeralSubject(store, ANON.subject, ADA.subject);
      expect(report).toEqual({ apps: 1, threads: 1, states: 1, skipped: 0 });

      // Ada now owns everything the session created…
      expect((await apps.list(ADA)).map((row) => row.id)).toContain("app_anon_merge");
      expect(await store.records("app:app_anon_merge:notes").get("note_1")).toMatchObject({
        data: { text: "keep me" },
      });
      expect((await threadStore(store).list(ADA)).map((row) => row.id)).toContain("thr_anon_merge");
      expect(await stateStore(store).get(ADA, "app_anon_merge")).toEqual({ count: 3 });

      // …but consent did NOT transfer: no grant, no approval under either subject.
      expect(await grantStore(store).list(ADA)).toEqual([]);
      expect(await grantStore(store).list(ANON)).toEqual([]);
      expect(await approvalStore(store).pending(ADA)).toEqual([]);
      expect(await approvalStore(store).pending(ANON)).toEqual([]);
      const grantRows = await made.sql("SELECT subject FROM vendo_grants");
      expect(grantRows).toEqual([]);
      // The session registration is retired with the merge.
      expect(await made.sql("SELECT subject FROM vendo_sessions WHERE subject = $1", [ANON.subject])).toEqual([]);

      // Idempotent: the same merge again is a no-op.
      expect(await adoptEphemeralSubject(store, ANON.subject, ADA.subject)).toBe(null);
      expect((await apps.list(ADA)).filter((row) => row.id === "app_anon_merge")).toHaveLength(1);
    });

    it("never steals or overwrites existing durable rows", async () => {
      const store = made.store;
      const BOB: Principal = { kind: "user", subject: "user_bob" };
      const MALLORY: Principal = { kind: "user", subject: "anonymous_badc0de", ephemeral: true };
      const apps = appStore(store);
      const threads = threadStore(store);

      // Bob owns a durable app + thread + state.
      await apps.put(BOB, appFixture("app_bobs_own", "Bob's app"));
      await threads.put(BOB, { id: "thr_bobs_own", messages: [{ role: "user", text: "bob" }] });
      await stateStore(store).put(BOB, "app_bobs_own", { bobs: true });
      // The signed-in Mallory already has her own state for Bob's app.
      await stateStore(store).put({ kind: "user", subject: "user_mallory" }, "app_bobs_own", { hers: true });

      // Mallory's anonymous session cannot even plant rows under Bob's ids — the
      // write doors refuse the cross-subject flip outright (02 §2).
      await registerEphemeralSubject(store, MALLORY.subject);
      await expect(apps.put(MALLORY, appFixture("app_bobs_own", "EVIL")))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      await expect(threads.put(MALLORY, { id: "thr_bobs_own", messages: [{ role: "user", text: "evil" }] }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      // State is keyed (app_id, subject): her copy lands under HER subject only.
      await stateStore(store).put(MALLORY, "app_bobs_own", { bobs: false });

      // Mallory signs in: her state copy collides with the one user_mallory
      // already owns — skipped, never overwritten — and Bob keeps everything.
      const report = await adoptEphemeralSubject(store, MALLORY.subject, "user_mallory");
      expect(report).toEqual({ apps: 0, threads: 0, states: 0, skipped: 1 });
      const bobApp = await apps.get("app_bobs_own");
      expect(bobApp?.subject).toBe(BOB.subject);
      expect(bobApp?.doc.name).toBe("Bob's app");
      expect((await threads.get(BOB, "thr_bobs_own"))?.subject).toBe(BOB.subject);
      expect(await stateStore(store).get(BOB, "app_bobs_own")).toEqual({ bobs: true });
      expect(await stateStore(store).get({ kind: "user", subject: "user_mallory" }, "app_bobs_own")).toEqual({ hers: true });
    });

    it("refuses merging into reserved or ephemeral subjects and into itself", async () => {
      const store = made.store;
      await registerEphemeralSubject(store, "anonymous_feed");
      await registerEphemeralSubject(store, "anonymous_f00d");
      await expect(adoptEphemeralSubject(store, "anonymous_feed", "vendo:org:org_1"))
        .rejects.toMatchObject({ code: "validation" });
      await expect(adoptEphemeralSubject(store, "anonymous_feed", "anonymous_f00d"))
        .rejects.toMatchObject({ code: "validation" });
      await expect(adoptEphemeralSubject(store, "anonymous_feed", "anonymous_feed"))
        .rejects.toMatchObject({ code: "validation" });
    });
  });
}
