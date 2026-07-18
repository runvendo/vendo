import { VendoError, type SecretsProvider } from "@vendoai/core";
import { decryptSecret, encryptSecret, getEncryptionKey, plaintextSecretsAllowed } from "./crypto.js";
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

/** 02-store §4 — dev-mode plaintext envelope. Version-prefixed like the
 *  encrypted `v2:` envelope so a store that later gains a key still reads
 *  rows written before it. */
const PLAINTEXT_PREFIX = "plain@1:";

/** The key when configured; null when plaintext is allowed (dev mode);
 *  fail-closed otherwise — production stores secrets encrypted or not at all. */
function keyFor(store: VendoStore): Buffer | null {
  const key = getEncryptionKey(store);
  if (key) return key;
  if (plaintextSecretsAllowed(store)) return null;
  throw new VendoError(
    "not-implemented",
    "Stored secrets require an encryption key in production: set VENDO_STORE_ENCRYPTION_KEY "
      + "(base64 32-byte) or pass createStore({ encryption: { key } }).",
  );
}

/** 02-store §1 */
export function storeSecrets(store: VendoStore): SecretsProvider {
  const db = dbFor(store);
  return {
    async get(name) {
      const key = keyFor(store);
      const result = await db.query("SELECT ciphertext FROM vendo_secrets WHERE name = $1", [name]);
      const row = result.rows[0];
      if (!row) return undefined;
      const stored = text(row["ciphertext"]);
      if (stored.startsWith(PLAINTEXT_PREFIX)) {
        return Buffer.from(stored.slice(PLAINTEXT_PREFIX.length), "base64").toString("utf8");
      }
      if (key === null) {
        throw new VendoError("validation", "Stored secret is encrypted but no encryption key is configured");
      }
      return decryptSecret(stored, key, name);
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
      const key = keyFor(store);
      const ciphertext = key === null
        ? `${PLAINTEXT_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`
        : encryptSecret(value, key, name);
      // updated_at marks the last write (rotation), distinct from created_at.
      await db.query(
        `INSERT INTO vendo_secrets (name, ciphertext, created_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = EXCLUDED.updated_at`,
        [name, ciphertext, new Date().toISOString()],
      );
    },
    async delete(name) {
      await db.query("DELETE FROM vendo_secrets WHERE name = $1", [name]);
    },
    async list() {
      const result = await db.query("SELECT name FROM vendo_secrets");
      // Sort in JS: SQL ORDER BY is collation-dependent (PGlite ships C,
      // hosted Postgres usually a locale) — one deterministic order everywhere.
      return result.rows.map((row) => text(row["name"])).sort();
    },
  };
}
