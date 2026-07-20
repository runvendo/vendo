import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { appFixture, approvalFixture, grantFixture } from "../fixtures.test-util.js";
import { approvalStore } from "./approvals.js";
import { stateStore } from "./state.js";
import {
  adoptEphemeralSubject,
  appStore,
  createStore,
  grantStore,
  registerEphemeralSubject,
  sweepEphemeralSubjects,
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

// Kill-list B3 review: the TTL sweep and adoption serialize on the session row
// (claim-first — whoever DELETEs the vendo_sessions row owns the subject's
// fate). Without it, a sweep that captured the subject's app ids could erase
// data an interleaved adopt had just moved to the signed-in user. PGlite
// serves queries FIFO, so Promise.all below is a DETERMINISTIC interleaving:
// the sweep's stale SELECT captures the subject, the adopt claims the session
// row first, and the sweep must then skip the erase.
describe("adopt/sweep serialization on the session row (kill-list B3 review)", () => {
  it("adopted data survives a sweep that captured the subject before the adopt claimed it", async () => {
    const store = createStore({ dataDir: "memory://" });
    await store.ensureSchema();
    const RACER: Principal = { kind: "user", subject: "anonymous_racer", ephemeral: true };
    await registerEphemeralSubject(store, RACER.subject, 0);
    await appStore(store).put(RACER, appFixture("app_race", "Raced app"));
    await store.records("app:app_race:notes").put({ id: "note_race", data: { keep: true } });
    await stateStore(store).put(RACER, "app_race", { n: 1 });
    await threadStore(store).put(RACER, { id: "thr_race", messages: [{ role: "user" }] });

    // Interleaving (FIFO): sweep SELECTs the stale subject; adopt claims the
    // session row; sweep's claim loses and it must skip the erase cascade.
    const [report, swept] = await Promise.all([
      adoptEphemeralSubject(store, RACER.subject, "user_winner"),
      sweepEphemeralSubjects(store, { idleMs: 1, now: 10_000 }),
    ]);

    expect(report).toEqual({ apps: 1, threads: 1, states: 1, skipped: 0 });
    expect(swept).toEqual([]); // the sweep lost the claim and skipped
    // Everything the adopt moved is intact under the signed-in subject.
    expect((await appStore(store).get("app_race"))?.subject).toBe("user_winner");
    expect((await store.records("app:app_race:notes").get("note_race"))?.data).toEqual({ keep: true });
    expect(await stateStore(store).get({ kind: "user", subject: "user_winner" }, "app_race")).toEqual({ n: 1 });
    expect((await threadStore(store).list({ kind: "user", subject: "user_winner" })).map((row) => row.id))
      .toContain("thr_race");
    // The session row is gone either way; a replayed adopt is a no-op.
    expect(await adoptEphemeralSubject(store, RACER.subject, "user_winner")).toBe(null);
    await store.close();
  });

  it("a sweep that claimed the subject first makes a late adopt a no-op", async () => {
    const store = createStore({ dataDir: "memory://" });
    await store.ensureSchema();
    const LOSER: Principal = { kind: "user", subject: "anonymous_late", ephemeral: true };
    await registerEphemeralSubject(store, LOSER.subject, 0);
    await appStore(store).put(LOSER, appFixture("app_late", "Late app"));

    expect(await sweepEphemeralSubjects(store, { idleMs: 1, now: 10_000 })).toEqual([LOSER.subject]);
    // The sweep owned the subject: its data is gone and the adopt finds nothing.
    expect(await adoptEphemeralSubject(store, LOSER.subject, "user_too_late")).toBe(null);
    expect(await appStore(store).get("app_late")).toBeNull();
    await store.close();
  });
});
