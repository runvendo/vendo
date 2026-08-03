import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { adoptEphemeralSubject, eraseStore, storeFiles } from "./index.js";

/**
 * Build-contract amendment 2026-07-30 — `vendo_effects.outcome` holds real tool
 * output, so the ledger has to be reachable by the erase cascade and travel with
 * an anon→signed-in adoption. Before the amendment the frozen shape had no
 * subject column and receipts survived an erase forever.
 */
const alice: Principal = { kind: "user", subject: "user_alice" };
const anon: Principal = { kind: "user", subject: "anonymous_visitor" };

/** Seed through the store's own door — the same write path the guard uses —
 *  never raw SQL: a raw INSERT would keep these tests green even if routing
 *  sent real receipts to the wrong table, which is exactly what happened
 *  (wave-1 independent check, finding 2: a gate that cannot fail). */
async function seedEffect(made: MadeBackend, key: string, subject: string): Promise<void> {
  await made.store.records("vendo_effects").put({
    id: key,
    data: { subject, outcome: { status: "ok", output: { receipt: key } } },
  });
}

for (const backend of backends()) {
  describe(`${backend.name} vendo_effects carries a subject`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("has a NOT NULL subject column and an index on it", async () => {
      const columns = await made.sql(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'vendo_effects' AND column_name = 'subject'`,
      );
      expect(columns).toHaveLength(1);
      expect(columns[0]!["is_nullable"]).toBe("NO");

      const indexes = await made.sql(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'vendo_effects'",
      );
      expect(indexes.some((row) => /\(subject\)/.test(String(row["indexdef"])))).toBe(true);
    });

    it("erases a subject's effect receipts and spares everyone else's", async () => {
      await seedEffect(made, "eff_alice_1", alice.subject);
      await seedEffect(made, "eff_alice_2", alice.subject);
      await seedEffect(made, "eff_bystander", "user_bystander");

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).bySubject(alice.subject);

      expect(report.vendo_effects).toBe(2);
      const left = await made.sql("SELECT key FROM vendo_effects ORDER BY key");
      expect(left.map((row) => row["key"])).toEqual(["eff_bystander"]);
    });

    it("moves effect receipts onto the signed-in subject on adoption", async () => {
      // Otherwise a re-run after sign-in would re-charge: the receipts proving
      // the work already happened would be stranded under the retired anon id.
      await seedEffect(made, "eff_anon_1", anon.subject);
      // Adoption claims the session row first, so the visitor must be registered.
      await made.sql(
        "INSERT INTO vendo_sessions (subject, touched_at) VALUES ($1, now())",
        [anon.subject],
      );

      const report = await adoptEphemeralSubject(made.store, anon.subject, "user_signed_in", { files: storeFiles(made.store) });

      expect(report?.effects).toBe(1);
      const rows = await made.sql("SELECT subject FROM vendo_effects WHERE key = 'eff_anon_1'");
      expect(rows[0]!["subject"]).toBe("user_signed_in");
    });
  });
}
