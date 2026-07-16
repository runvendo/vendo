import { randomBytes } from "node:crypto";
import { VendoError } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { appStore, createStore, envSecrets, secretStore, storeSecrets } from "./index.js";
import { appFixture, persistentPrincipal } from "./fixtures.test-util.js";

for (const backend of backends()) {
  describe(backend.name, () => {
    let made: MadeBackend;
    const key = randomBytes(32).toString("base64");

    beforeAll(async () => {
      made = await backend.make();
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption: { key } });
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("reads environment secrets with and without a prefix", async () => {
      process.env.VENDO_TEST_PLAIN = "plain-value";
      process.env.VENDO_TEST_PREFIX_TOKEN = "prefixed-value";
      try {
        expect(await envSecrets().get("VENDO_TEST_PLAIN")).toBe("plain-value");
        expect(await envSecrets("VENDO_TEST_PREFIX_").get("TOKEN")).toBe("prefixed-value");
        expect(await envSecrets("VENDO_TEST_PREFIX_").get("MISSING")).toBeUndefined();
      } finally {
        delete process.env.VENDO_TEST_PLAIN;
        delete process.env.VENDO_TEST_PREFIX_TOKEN;
      }
    });

    it("round-trips encrypted stored secrets and never stores plaintext", async () => {
      await secretStore(made.store).set("API_TOKEN", "plain-secret-value");
      expect(await storeSecrets(made.store).get("API_TOKEN")).toBe("plain-secret-value");
      const row = (await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'API_TOKEN'"))[0];
      expect(String(row?.ciphertext)).not.toContain("plain-secret-value");
    });

    it("lists and deletes stored secrets", async () => {
      await secretStore(made.store).set("B_SECRET", "b");
      await secretStore(made.store).set("A_SECRET", "a");
      expect(await secretStore(made.store).list()).toEqual(["API_TOKEN", "A_SECRET", "B_SECRET"]);
      await secretStore(made.store).delete("B_SECRET");
      expect(await secretStore(made.store).list()).toEqual(["API_TOKEN", "A_SECRET"]);
      expect(await storeSecrets(made.store).get("B_SECRET")).toBeUndefined();
    });

    it("re-encrypts the same value differently each write (GCM nonce)", async () => {
      // §4 AES-256-GCM: a fresh random nonce per write means ciphertext is non-deterministic,
      // even for identical plaintext under the same key — no equal-value fingerprinting on disk.
      await secretStore(made.store).set("NONCE_SECRET", "identical-plaintext");
      const first = String((await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'NONCE_SECRET'"))[0]?.ciphertext);
      await secretStore(made.store).set("NONCE_SECRET", "identical-plaintext");
      const second = String((await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'NONCE_SECRET'"))[0]?.ciphertext);
      expect(second).not.toBe(first);
      expect(await storeSecrets(made.store).get("NONCE_SECRET")).toBe("identical-plaintext");
      await secretStore(made.store).delete("NONCE_SECRET");
    });

    it("keeps app record data plaintext even when encryption is configured", async () => {
      // §4: only vendo_secrets.ciphertext is encrypted; app data stays plaintext so the
      // host-can-query/join promise survives — encrypting it would defeat §2.
      await appStore(made.store).put(persistentPrincipal, appFixture("app_plain")); // ENG-237: owning app
      await made.store.records("app:app_plain:notes").put({
        id: "plain_note",
        data: { body: "queryable-cleartext" },
        refs: { kind: "note" },
      });
      const row = (await made.sql("SELECT data FROM vendo_records WHERE id = 'plain_note'"))[0];
      expect(row?.data).toEqual({ body: "queryable-cleartext" });
      const matched = await made.sql(
        "SELECT id FROM vendo_records WHERE data->>'body' = 'queryable-cleartext'",
      );
      expect(matched.map((r) => r.id)).toContain("plain_note");
    });

    it("survives close and reopen with the same encryption key", async () => {
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption: { key } });
      await made.store.ensureSchema();
      expect(await storeSecrets(made.store).get("API_TOKEN")).toBe("plain-secret-value");
    });

    it("rejects decryption with a different key as validation", async () => {
      await made.store.close();
      const wrong = createStore({
        url: made.url,
        dataDir: made.dataDir,
        encryption: { key: randomBytes(32).toString("base64") },
      });
      try {
        await wrong.ensureSchema();
        await expect(storeSecrets(wrong).get("API_TOKEN")).rejects.toMatchObject<VendoError>({ code: "validation" });
      } finally {
        await wrong.close();
      }
      made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption: { key } });
      await made.store.ensureSchema();
    });

    it("rejects malformed encryption keys at createStore time", () => {
      expect(() => createStore({ encryption: { key: Buffer.from("too short").toString("base64") } }))
        .toThrow(expect.objectContaining<VendoError>({ code: "validation" }));
    });

    it("reports stored secrets as unavailable without encryption", async () => {
      const plain = createStore();
      try {
        await expect(storeSecrets(plain).get("ANY")).rejects.toMatchObject<VendoError>({ code: "not-implemented" });
      } finally {
        await plain.close();
      }
    });
  });
}
