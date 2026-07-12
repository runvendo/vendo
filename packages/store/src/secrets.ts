import { VendoError, type SecretsProvider } from "@vendoai/core";
import { decryptSecret, encryptSecret, getEncryptionKey } from "./crypto.js";
import { dbFor, type VendoStore } from "./store.js";
import { text } from "./helpers/utils.js";

/** 02-store §1 */
export function envSecrets(prefix = ""): SecretsProvider {
  return {
    async get(name) {
      return process.env[`${prefix}${name}`];
    },
  };
}

function keyFor(store: VendoStore): Buffer {
  const key = getEncryptionKey(store);
  if (!key) {
    throw new VendoError(
      "not-implemented",
      "Stored secrets require createStore({ encryption: { key } })",
    );
  }
  return key;
}

/** 02-store §1 */
export function storeSecrets(store: VendoStore): SecretsProvider {
  const db = dbFor(store);
  return {
    async get(name) {
      const key = keyFor(store);
      const result = await db.query("SELECT ciphertext FROM vendo_secrets WHERE name = $1", [name]);
      const row = result.rows[0];
      return row ? decryptSecret(text(row["ciphertext"]), key) : undefined;
    },
  };
}

/** 02-store §3 */
export function secretStore(store: VendoStore): {
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
} {
  const db = dbFor(store);
  return {
    async set(name, value) {
      const ciphertext = encryptSecret(value, keyFor(store));
      await db.query(
        `INSERT INTO vendo_secrets (name, ciphertext, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
        [name, ciphertext, new Date().toISOString()],
      );
    },
    async delete(name) {
      await db.query("DELETE FROM vendo_secrets WHERE name = $1", [name]);
    },
    async list() {
      const result = await db.query("SELECT name FROM vendo_secrets ORDER BY name ASC");
      return result.rows.map((row) => text(row["name"]));
    },
  };
}
