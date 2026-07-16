import { VendoError, type BlobStore } from "@vendoai/core";
import type { Db } from "./db.js";
import { appEphemerality, appScopeId, overlayFor, snapshot, type AppEphemerality } from "./ephemeral.js";
import { text } from "./helpers/utils.js";
import type { VendoStore } from "./store.js";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** 01-core §12 */
export function createBlobStore(store: VendoStore, db: Db, namespace: string): BlobStore {
  const appId = appScopeId(namespace);
  const ephemeralBlobs = (): Map<string, { bytes: Uint8Array; contentType?: string }> => {
    const blobs = overlayFor(store).blobs;
    let namespaceBlobs = blobs.get(namespace);
    if (!namespaceBlobs) {
      namespaceBlobs = new Map();
      blobs.set(namespace, namespaceBlobs);
    }
    return namespaceBlobs;
  };
  // ENG-237 (STORE-1): mirrors records.ts — an app-scoped blob write to an
  // "unknown" app (never existed / session evicted) fails closed rather than
  // orphaning a durable row; reads on "unknown" return empty.
  const ephemerality = async (): Promise<AppEphemerality> =>
    appId === undefined ? "durable" : await appEphemerality(store, db, appId);
  const requireKnownApp = (state: AppEphemerality): void => {
    if (state === "unknown") {
      throw new VendoError("not-found", `app ${appId} does not exist (its session may have expired)`);
    }
  };

  return {
    async put(key, bytes, meta) {
      const state = await ephemerality();
      requireKnownApp(state);
      if (state === "ephemeral") {
        ephemeralBlobs().set(key, snapshot({
          bytes,
          ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
        }));
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
      const state = await ephemerality();
      if (state === "unknown") return null;
      if (state === "ephemeral") {
        const found = overlayFor(store).blobs.get(namespace)?.get(key);
        return found ? snapshot(found) : null;
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
      const state = await ephemerality();
      requireKnownApp(state);
      if (state === "ephemeral") {
        overlayFor(store).blobs.get(namespace)?.delete(key);
        return;
      }
      await db.query("DELETE FROM vendo_blobs WHERE namespace = $1 AND key = $2", [namespace, key]);
    },
    async list(prefix = "") {
      const state = await ephemerality();
      if (state === "unknown") return [];
      if (state === "ephemeral") {
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
