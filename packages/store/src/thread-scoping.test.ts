/** B1 — vendo_threads never lets one subject take over another's thread row.
 *
 * vendo_threads is keyed by the bare id, so a naive upsert would let any caller
 * flip the row's subject. The store refuses the cross-subject flip ATOMICALLY at
 * the write door (03 §5): the guarded SQL upsert on the persistent path, and a
 * prior-owner check on the ephemeral overlay path. Same-subject re-puts still
 * update in place.
 */
import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { registerEphemeralSubject, threadStore } from "./index.js";

const u1: Principal = { kind: "user", subject: "user_one" };
const u2: Principal = { kind: "user", subject: "user_two" };

for (const backend of backends()) {
  describe(`${backend.name} vendo_threads cross-subject refusal (B1)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("refuses a cross-subject flip on the persistent SQL path, row intact", async () => {
      const threads = threadStore(made.store);
      await threads.put(u1, { id: "thr_sql", messages: [{ role: "user", text: "mine" }] });

      // u2 trying to write the same id is a conflict — the guarded upsert's WHERE
      // fails, RETURNING is empty, and nothing is written.
      await expect(threads.put(u2, { id: "thr_sql", messages: [{ role: "user", text: "steal" }] }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });

      // u1's row is byte-for-byte intact.
      expect(await made.sql("SELECT id, subject, messages FROM vendo_threads WHERE id = 'thr_sql'"))
        .toEqual([{ id: "thr_sql", subject: "user_one", messages: [{ role: "user", text: "mine" }] }]);

      // Same-subject re-put still updates in place.
      await threads.put(u1, { id: "thr_sql", messages: [{ role: "user", text: "updated" }] });
      expect((await made.sql("SELECT messages FROM vendo_threads WHERE id = 'thr_sql'"))[0]?.["messages"])
        .toEqual([{ role: "user", text: "updated" }]);
    });

    it("refuses a cross-subject flip on the routed seam (records vendo_threads)", async () => {
      const seam = made.store.records("vendo_threads");
      await seam.put({ id: "thr_seam", data: { subject: u1.subject, messages: [{ role: "user", text: "mine" }] } });
      await expect(seam.put({ id: "thr_seam", data: { subject: u2.subject, messages: [] } }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      expect(await made.sql("SELECT subject FROM vendo_threads WHERE id = 'thr_seam'"))
        .toEqual([{ subject: "user_one" }]);
    });

    it("refuses a cross-subject flip on the ephemeral overlay path", async () => {
      const e1: Principal = { kind: "user", subject: "sess_one", ephemeral: true };
      const e2: Principal = { kind: "user", subject: "sess_two", ephemeral: true };
      registerEphemeralSubject(made.store, e1.subject);
      registerEphemeralSubject(made.store, e2.subject);
      const threads = threadStore(made.store);
      await threads.put(e1, { id: "thr_overlay", messages: [{ role: "user", text: "mine" }] });
      await expect(threads.put(e2, { id: "thr_overlay", messages: [] }))
        .rejects.toMatchObject<VendoError>({ code: "conflict" });
      // Nothing hit disk for the ephemeral thread, and e1 still owns the overlay row.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_threads WHERE id = 'thr_overlay'",
      ))[0]?.["count"])).toBe(0);
      expect((await threads.get(e1, "thr_overlay"))?.subject).toBe("sess_one");
      expect(await threads.get(e2, "thr_overlay")).toBeNull();
    });
  });

  describe(`${backend.name} vendo_threads guarded writes (ENG-310)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const threadData = (subject: string, text: string): { subject: string; messages: unknown[] } => ({
      subject,
      messages: [{ role: "user", text }],
    });

    it("exposes atomic on the routed seam: one insert winner, revision-guarded swaps", async () => {
      const seam = made.store.records("vendo_threads");
      expect(seam.atomic).toBeDefined();

      // Exactly one concurrent first-persist lands; the loser gets null.
      const [first, second] = await Promise.all([
        seam.atomic!.insertIfAbsent({ id: "thr_cas", data: threadData(u1.subject, "one") }),
        seam.atomic!.insertIfAbsent({ id: "thr_cas", data: threadData(u1.subject, "two") }),
      ]);
      const winners = [first, second].filter((record) => record !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.revision).toBe("1");

      // Only the CURRENT revision swaps — and exactly one concurrent swapper wins.
      const revision = winners[0]!.revision!;
      const swaps = await Promise.all([
        seam.atomic!.compareAndSwap({ id: "thr_cas", data: threadData(u1.subject, "swap a") }, revision),
        seam.atomic!.compareAndSwap({ id: "thr_cas", data: threadData(u1.subject, "swap b") }, revision),
      ]);
      expect(swaps.filter((record) => record !== null)).toHaveLength(1);
      const surviving = swaps[0] !== null ? "swap a" : "swap b";
      expect((await seam.get("thr_cas"))?.data).toMatchObject({
        messages: [{ role: "user", text: surviving }],
      });
      // The stale token keeps losing.
      expect(await seam.atomic!.compareAndSwap(
        { id: "thr_cas", data: threadData(u1.subject, "stale") },
        revision,
      )).toBeNull();
      // A malformed token is refused outright, not treated as a miss.
      await expect(seam.atomic!.compareAndSwap(
        { id: "thr_cas", data: threadData(u1.subject, "junk token") },
        "not-a-revision",
      )).rejects.toMatchObject<VendoError>({ code: "validation" });
      // Plain put still bumps the counter, so a pre-put token can no longer swap.
      const bumped = await seam.put({ id: "thr_cas", data: threadData(u1.subject, "via put") });
      expect(BigInt(bumped.revision!)).toBeGreaterThan(BigInt(revision));
    });

    it("a foreign subject can never land a guarded write, even with the current revision", async () => {
      const seam = made.store.records("vendo_threads");
      const mine = await seam.put({ id: "thr_cas_foreign", data: threadData(u1.subject, "mine") });

      // insertIfAbsent: the id is taken → null, no takeover.
      expect(await seam.atomic!.insertIfAbsent({
        id: "thr_cas_foreign",
        data: threadData(u2.subject, "steal by insert"),
      })).toBeNull();
      // compareAndSwap with the RIGHT revision but the WRONG subject → null, row intact.
      expect(await seam.atomic!.compareAndSwap(
        { id: "thr_cas_foreign", data: threadData(u2.subject, "steal by swap") },
        mine.revision!,
      )).toBeNull();
      expect(await made.sql("SELECT subject, messages FROM vendo_threads WHERE id = 'thr_cas_foreign'"))
        .toEqual([{ subject: u1.subject, messages: [{ role: "user", text: "mine" }] }]);
    });

    it("guards the ephemeral overlay path the same way", async () => {
      const eSubject = "sess_cas";
      registerEphemeralSubject(made.store, eSubject);
      const seam = made.store.records("vendo_threads");

      const inserted = await seam.atomic!.insertIfAbsent({
        id: "thr_cas_overlay",
        data: threadData(eSubject, "overlay one"),
      });
      expect(inserted).not.toBeNull();
      expect(inserted!.revision).toBe("1");
      expect(await seam.atomic!.insertIfAbsent({
        id: "thr_cas_overlay",
        data: threadData(eSubject, "overlay dupe"),
      })).toBeNull();

      const swapped = await seam.atomic!.compareAndSwap(
        { id: "thr_cas_overlay", data: threadData(eSubject, "overlay two") },
        "1",
      );
      expect(swapped).not.toBeNull();
      expect(swapped!.revision).toBe("2");
      expect(await seam.atomic!.compareAndSwap(
        { id: "thr_cas_overlay", data: threadData(eSubject, "overlay stale") },
        "1",
      )).toBeNull();

      // Nothing hit disk: the overlay owns the row.
      expect(Number((await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_threads WHERE id = 'thr_cas_overlay'",
      ))[0]?.["count"])).toBe(0);
    });
  });
}
