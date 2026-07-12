import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { createStore, secretStore, storeSecrets } from "../index.js";

// Adversarial regression suite: the encrypted secrets table (vendo_secrets) is
// physically and logically isolated from the app-visible record surface. An app
// asking store.records("vendo_secrets") must NOT reach the real ciphertext table
// — "vendo_secrets" is not a reserved routed collection, so it lands as an
// ordinary (empty) collection tag inside vendo_records, a different table.

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    const key = randomBytes(32).toString("base64");

    beforeAll(async () => {
      made = await backend.make();
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption: { key } });
      await made.store.ensureSchema();
      await secretStore(made.store).set("STRIPE_KEY", "sk-live-do-not-leak");
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("stored the secret and can read it back through the secrets API", async () => {
      expect(await storeSecrets(made.store).get("STRIPE_KEY")).toBe("sk-live-do-not-leak");
    });

    it("does NOT surface the ciphertext row through store.records('vendo_secrets')", async () => {
      // "vendo_secrets" routes to the generic record store (it is not in
      // RESERVED_COLLECTIONS), which reads vendo_records — a DIFFERENT physical
      // table from vendo_secrets. Nothing is there.
      const records = made.store.records("vendo_secrets");
      expect(await records.get("STRIPE_KEY")).toBeNull();
      const listed = await records.list();
      expect(listed.records).toHaveLength(0);
    });

    it("secretStore.list() returns names only — never values or ciphertext", async () => {
      await secretStore(made.store).set("RESEND_KEY", "re-live-also-secret");
      const names = await secretStore(made.store).list();
      expect(names).toEqual(["RESEND_KEY", "STRIPE_KEY"]);
      // The listed strings are the names verbatim, carrying no secret material.
      for (const name of names) {
        expect(name).not.toContain("sk-live");
        expect(name).not.toContain("re-live");
        expect(name).not.toContain("v1:"); // no ciphertext envelope leaked
      }
    });
  });
}
