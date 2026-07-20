import type { BlobStore } from "@vendoai/core";
import type { Db } from "./db.js";
import { appScopeId, escapeLike, requireKnownApp, text, unknownAppError } from "./helpers/utils.js";

/** 01-core §12 */
export function createBlobStore(db: Db, namespace: string): BlobStore {
  const appId = appScopeId(namespace);
  // STORE-1: mirrors records.ts — an app-scoped blob WRITE for an app with no
  // vendo_apps row (never existed / session swept) fails closed rather than
  // recreating rows no erase cascade would reach; reads come back empty. The
  // row-creating put carries the gate IN the statement (structural, not
  // ordering care); delete keeps the pre-check as its error signal.
  const appGate = appId === undefined ? "" : "WHERE EXISTS (SELECT 1 FROM vendo_apps WHERE id = $6)";
  const appGateParams = appId === undefined ? [] : [appId];

  return {
    async put(key, bytes, meta) {
      const result = await db.query(
        `INSERT INTO vendo_blobs (namespace, key, bytes, content_type, created_at)
         SELECT $1::text, $2::text, $3::bytea, $4::text, $5::timestamptz
         ${appGate}
         ON CONFLICT (namespace, key) DO UPDATE
         SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type
         RETURNING key`,
        [
          namespace,
          key,
          // node-postgres only recognizes Buffer as bytea; a plain Uint8Array
          // would be serialized as JSON. PGlite accepts Buffer (a Uint8Array).
          Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          meta?.contentType ?? null,
          new Date().toISOString(),
          ...appGateParams,
        ],
      );
      // The upsert always returns a row unless the app-existence gate refused it.
      if (result.rows[0] === undefined && appId !== undefined) throw unknownAppError(appId);
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
        // Normalize to a plain Uint8Array so both drivers return one shape
        // (pg hands back Buffer, PGlite hands back Uint8Array).
        bytes: new Uint8Array(bytes),
        ...(typeof contentType === "string" ? { contentType } : {}),
      };
    },
    async delete(key) {
      // DELETE never creates rows, so the pre-check is only the error signal.
      await requireKnownApp(db, appId);
      await db.query("DELETE FROM vendo_blobs WHERE namespace = $1 AND key = $2", [namespace, key]);
    },
    async list(prefix = "") {
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
