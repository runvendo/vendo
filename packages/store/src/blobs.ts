import type { BlobStore } from "@vendoai/core";
import type { Db } from "./db.js";
import { isEphemeralApp, overlayFor } from "./ephemeral.js";
import { text } from "./helpers/utils.js";
import type { VendoStore } from "./store.js";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** 01-core §12 */
export function createBlobStore(store: VendoStore, db: Db, namespace: string): BlobStore {
  const appId = /^app:([^:]+):/.exec(namespace)?.[1];
  const ephemeralBlobs = (): Map<string, { bytes: Uint8Array; contentType?: string }> => {
    const blobs = overlayFor(store).blobs;
    let namespaceBlobs = blobs.get(namespace);
    if (!namespaceBlobs) {
      namespaceBlobs = new Map();
      blobs.set(namespace, namespaceBlobs);
    }
    return namespaceBlobs;
  };
  const isEphemeral = async (): Promise<boolean> => appId !== undefined && isEphemeralApp(store, db, appId);

  return {
    async put(key, bytes, meta) {
      if (await isEphemeral()) {
        ephemeralBlobs().set(key, {
          bytes: new Uint8Array(bytes),
          ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
        });
        return;
      }
      await db.query(
        `INSERT INTO vendo_blobs (namespace, key, bytes, content_type, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (namespace, key) DO UPDATE
         SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type`,
        [
          namespace,
          key,
          // node-postgres only recognizes Buffer as bytea; a plain Uint8Array
          // would be serialized as JSON. PGlite accepts Buffer (a Uint8Array).
          Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          meta?.contentType ?? null,
          new Date().toISOString(),
        ],
      );
    },
    async get(key) {
      if (await isEphemeral()) {
        const found = overlayFor(store).blobs.get(namespace)?.get(key);
        return found ? { ...found, bytes: new Uint8Array(found.bytes) } : null;
      }
      const result = await db.query(
        "SELECT bytes, content_type FROM vendo_blobs WHERE namespace = $1 AND key = $2",
        [namespace, key],
      );
      const row = result.rows[0];
      if (!row) return null;
      const bytes = row["bytes"];
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected database bytea");
      const contentType = row["content_type"];
      return {
        // Normalize to a plain Uint8Array so both drivers return one shape
        // (pg hands back Buffer, PGlite hands back Uint8Array).
        bytes: new Uint8Array(bytes),
        ...(typeof contentType === "string" ? { contentType } : {}),
      };
    },
    async delete(key) {
      if (await isEphemeral()) {
        overlayFor(store).blobs.get(namespace)?.delete(key);
        return;
      }
      await db.query("DELETE FROM vendo_blobs WHERE namespace = $1 AND key = $2", [namespace, key]);
    },
    async list(prefix = "") {
      if (await isEphemeral()) {
        return [...(overlayFor(store).blobs.get(namespace)?.keys() ?? [])]
          .filter((key) => key.startsWith(prefix))
          .sort();
      }
      const result = await db.query(
        "SELECT key FROM vendo_blobs WHERE namespace = $1 AND key LIKE $2 ESCAPE '\\'",
        [namespace, `${escapeLike(prefix)}%`],
      );
      // Sort in JS: SQL ORDER BY is collation-dependent (PGlite ships C,
      // hosted Postgres usually a locale) — one deterministic order everywhere.
      return result.rows.map((row) => text(row["key"])).sort();
    },
  };
}
