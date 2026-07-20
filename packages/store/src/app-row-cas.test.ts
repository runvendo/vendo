/** Wave 7 — vendo_apps guarded writes (01 §12 atomic capability).
 *
 * The machine lifecycle and the schedule engine's fire claims arbitrate racers
 * through read-mutate-CAS on the app row (updateAppRow in @vendoai/apps).
 * Before this, the routed vendo_apps seam carried no revision, so the dev
 * store silently degraded to read-then-put — a multi-process dev host could
 * double-fire a schedule or clobber a concurrent lifecycle write. Same
 * capability shape as vendo_threads (ENG-310): a revision counter, one insert
 * winner, revision-guarded swaps, and the cross-subject refusal on every verb.
 */
import { VendoError } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appFixture } from "./fixtures.test-util.js";

const appData = (id: string, subject: string, name: string) => ({
  subject,
  enabled: false,
  doc: appFixture(id, name),
});

for (const backend of backends()) {
  describe(`${backend.name} vendo_apps guarded writes (Wave 7)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("exposes atomic on the routed seam: one insert winner, revision-guarded swaps", async () => {
      const seam = made.store.records("vendo_apps");
      expect(seam.atomic).toBeDefined();

      // Exactly one concurrent first-persist lands; the loser gets null.
      const [first, second] = await Promise.all([
        seam.atomic!.insertIfAbsent({ id: "app_cas", data: appData("app_cas", "user_one", "one") }),
        seam.atomic!.insertIfAbsent({ id: "app_cas", data: appData("app_cas", "user_one", "two") }),
      ]);
      const winners = [first, second].filter((record) => record !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.revision).toBe("1");

      // Only the CURRENT revision swaps — and exactly one concurrent swapper wins.
      const revision = winners[0]!.revision!;
      const swaps = await Promise.all([
        seam.atomic!.compareAndSwap({ id: "app_cas", data: appData("app_cas", "user_one", "swap a") }, revision),
        seam.atomic!.compareAndSwap({ id: "app_cas", data: appData("app_cas", "user_one", "swap b") }, revision),
      ]);
      expect(swaps.filter((record) => record !== null)).toHaveLength(1);
      const surviving = swaps[0] !== null ? "swap a" : "swap b";
      expect((await seam.get("app_cas"))?.data).toMatchObject({
        doc: { name: surviving },
      });
      // The stale token keeps losing.
      expect(await seam.atomic!.compareAndSwap(
        { id: "app_cas", data: appData("app_cas", "user_one", "stale") },
        revision,
      )).toBeNull();
      // A malformed token is refused outright, not treated as a miss.
      await expect(seam.atomic!.compareAndSwap(
        { id: "app_cas", data: appData("app_cas", "user_one", "junk token") },
        "not-a-revision",
      )).rejects.toMatchObject<VendoError>({ code: "validation" });
      // Plain put still bumps the counter, so a pre-put token can no longer swap.
      const bumped = await seam.put({ id: "app_cas", data: appData("app_cas", "user_one", "via put") });
      expect(BigInt(bumped.revision!)).toBeGreaterThan(BigInt(revision));
      // get() carries the current token, so read-mutate-CAS needs no extra verb.
      expect((await seam.get("app_cas"))?.revision).toBe(bumped.revision);
    });

    it("a foreign subject can never land a guarded write, even with the current revision", async () => {
      const seam = made.store.records("vendo_apps");
      const mine = await seam.put({ id: "app_cas_foreign", data: appData("app_cas_foreign", "user_one", "mine") });

      // insertIfAbsent: the id is taken → null, no takeover.
      expect(await seam.atomic!.insertIfAbsent({
        id: "app_cas_foreign",
        data: appData("app_cas_foreign", "user_two", "steal by insert"),
      })).toBeNull();
      // compareAndSwap with the RIGHT revision but the WRONG subject → null, row intact.
      expect(await seam.atomic!.compareAndSwap(
        { id: "app_cas_foreign", data: appData("app_cas_foreign", "user_two", "steal by swap") },
        mine.revision!,
      )).toBeNull();
      expect(await made.sql("SELECT subject FROM vendo_apps WHERE id = 'app_cas_foreign'"))
        .toEqual([{ subject: "user_one" }]);
    });

    it("guarded writes keep the trigger_kind projection the tick queries by", async () => {
      const seam = made.store.records("vendo_apps");
      const scheduled = {
        subject: "user_one",
        enabled: true,
        doc: {
          ...appFixture("app_cas_trigger", "scheduled"),
          trigger: {
            on: { kind: "schedule", cron: "0 8 * * *" },
            run: { kind: "agentic", prompt: "chase invoices" },
          },
        },
      };
      const inserted = await seam.atomic!.insertIfAbsent({ id: "app_cas_trigger", data: scheduled });
      expect(inserted?.refs).toMatchObject({ trigger_kind: "schedule" });
      expect((await seam.list({ refs: { trigger_kind: "schedule" } })).records
        .some((record) => record.id === "app_cas_trigger")).toBe(true);
    });
  });
}
