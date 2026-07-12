import type { BlobStore } from "@vendoai/core";
import type { Db } from "./db.js";
import { text } from "./helpers/utils.js";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** 01-core §12 */
export function createBlobStore(db: Db, namespace: string): BlobStore {
  return {
    async put(key, bytes, meta) {
      await db.query(
        `INSERT INTO vendo_blobs (namespace, key, bytes, content_type, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (namespace, key) DO UPDATE
         SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type`,
        [namespace, key, bytes, meta?.contentType ?? null, new Date().toISOString()],
      );
    },
    async get(key) {
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
        bytes,
        ...(typeof contentType === "string" ? { contentType } : {}),
      };
    },
    async delete(key) {
      await db.query("DELETE FROM vendo_blobs WHERE namespace = $1 AND key = $2", [namespace, key]);
    },
    async list(prefix = "") {
      const result = await db.query(
        "SELECT key FROM vendo_blobs WHERE namespace = $1 AND key LIKE $2 ESCAPE '\\' ORDER BY key ASC",
        [namespace, `${escapeLike(prefix)}%`],
      );
      return result.rows.map((row) => text(row["key"]));
    },
  };
}
