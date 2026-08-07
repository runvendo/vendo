import { VendoError } from "@vendoai/core";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../backends.test-util.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { createStore, secretStore, storeSecrets } from "../index.js";

// 02-store §4: "AES-GCM binds ciphertext to the secret name as AAD with
// envelope versioning." A v2 ciphertext swapped between rows or served under
// the wrong name fails the auth tag instead of decrypting to another
// secret's value.

describe("02-store §4 — secret-name AAD binding (envelope level)", () => {
  const key = randomBytes(32);

  it("rejects a v2 ciphertext decrypted under a different secret name", () => {
    const sealed = encryptSecret("value-for-a", key, "SECRET_A");
    expect(decryptSecret(sealed, key, "SECRET_A")).toBe("value-for-a");
    expect(() => decryptSecret(sealed, key, "SECRET_B"))
      .toThrow(expect.objectContaining<VendoError>({ code: "validation" }));
  });
});

for (const backend of backends()) {
  describe(`${backend.name} 02-store §4 — secret-name AAD + envelope versioning (stored)`, () => {
    let made: MadeBackend;
    const key = randomBytes(32).toString("base64");

    beforeAll(async () => {
      made = await backend.make();
      await made.store.close();
      made.store = createStore({ url: made.url, dataDir: made.dataDir, encryption: { key } });
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("writes new secrets in the v2 envelope and round-trips them", async () => {
      await secretStore(made.store).set("AAD_FRESH", "fresh-value");
      const row = (await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'AAD_FRESH'"))[0];
      expect(String(row?.ciphertext).startsWith("v2:")).toBe(true);
      expect(await storeSecrets(made.store).get("AAD_FRESH")).toBe("fresh-value");
    });

    it("rejects a cross-row ciphertext swap between v2 rows", async () => {
      await secretStore(made.store).set("AAD_SWAP_A", "value-a");
      await secretStore(made.store).set("AAD_SWAP_B", "value-b");
      const cipherA = String(
        (await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'AAD_SWAP_A'"))[0]?.ciphertext,
      );
      // The STORE-6 attack: splice one row's ciphertext into another row. Pre-AAD
      // this decrypted cleanly to the wrong secret's value; with the name bound
      // as AAD the auth tag fails.
      await made.sql("UPDATE vendo_secrets SET ciphertext = $1 WHERE name = 'AAD_SWAP_B'", [cipherA]);
      await expect(storeSecrets(made.store).get("AAD_SWAP_B"))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
      // The untouched row keeps decrypting.
      expect(await storeSecrets(made.store).get("AAD_SWAP_A")).toBe("value-a");
    });

    it("rejects a tampered v2 ciphertext", async () => {
      await secretStore(made.store).set("AAD_TAMPER", "tamper-me");
      const stored = String(
        (await made.sql("SELECT ciphertext FROM vendo_secrets WHERE name = 'AAD_TAMPER'"))[0]?.ciphertext,
      );
      const [version, iv, tag, ct] = stored.split(":");
      const bytes = Buffer.from(ct ?? "", "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      await made.sql(
        "UPDATE vendo_secrets SET ciphertext = $1 WHERE name = 'AAD_TAMPER'",
        [`${version}:${iv}:${tag}:${bytes.toString("base64")}`],
      );
      await expect(storeSecrets(made.store).get("AAD_TAMPER"))
        .rejects.toMatchObject<VendoError>({ code: "validation" });
    });
  });
}
