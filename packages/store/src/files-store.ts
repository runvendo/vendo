import { VendoError, type FilesAdapter } from "@vendoai/core";
import { createBlobStore } from "./blobs.js";
import type { Db } from "./db-postgres.js";
import { dbFor, type VendoStore } from "./store.js";

/** Build contract §3.4 — the cap on the no-adapter path, matching today's
    app-blob cap. Past it the host must wire a real files adapter. */
export const FILES_STORE_MAX_BYTES = 5 * 1024 * 1024;

/** The blob namespace the store-backed files adapter owns. Flat, and outside
    the `app:<id>:…` grammar, so no app gate applies. The erase cascade reaches
    these objects through the ROW that points at them (`blob_ref`), never
    through a key prefix — workspace-rows mints random `wsb_<uuid>` keys
    precisely so a row that changes owner (an anon adoption, a wave-3 promote)
    does not strand its content behind an unreachable key. */
export const WORKSPACE_BLOB_NAMESPACE = "workspace";

/**
 * Build contract §3.4 — the zero-configuration files adapter: no `files:`
 * wired, so workspace blobs live in the store's own `vendo_blobs`. Capped,
 * because a database is not an object store; the first over-cap write names
 * the fix rather than silently succeeding until Postgres complains.
 */
export function storeFiles(store: VendoStore): FilesAdapter {
  // The Db handle is bound LAZILY, on the first call. Every composition builds
  // this adapter for whatever store it composed — a hosted one included, where
  // `dbFor` has no handle to give and throws. A hosted deployment's blobs ride
  // the wire instead, so it never reaches these methods; binding eagerly turned
  // that into a boot failure.
  let bound: FilesAdapter | undefined;
  const local = (): FilesAdapter => (bound ??= storeFilesForDb(dbFor(store)));
  return {
    put: (key, bytes, meta) => local().put(key, bytes, meta),
    get: (key) => local().get(key),
    delete: (key) => local().delete(key),
  };
}

/** The same adapter bound to an explicit Db handle — ops.ts hands it the
 *  transaction-scoped query so a blob touched inside a verb's transaction
 *  rides that transaction instead of deadlocking PGlite's single connection. */
export function storeFilesForDb(db: Db): FilesAdapter {
  const blobs = createBlobStore(db, WORKSPACE_BLOB_NAMESPACE);
  return {
    async put(key, bytes, meta) {
      if (bytes.byteLength > FILES_STORE_MAX_BYTES) {
        throw new VendoError(
          "validation",
          `File is ${bytes.byteLength} bytes; the store-backed file cap is ${FILES_STORE_MAX_BYTES}`
            + " bytes. Wire `files:` with your own `FilesAdapter` to store files this large.",
        );
      }
      await blobs.put(key, bytes, meta);
    },
    async get(key) {
      return (await blobs.get(key)) ?? undefined;
    },
    async delete(key) {
      await blobs.delete(key);
    },
  };
}
