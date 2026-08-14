import type { BlobStore, RecordStore, StoreAdapter, StoreOps } from "@vendoai/core";
import { createBlobStore } from "./blobs.js";
import { validateEncryptionKey } from "#store/crypto";
// Type-only — erased at compile time. This module is the engine-agnostic
// store assembly shared by both entries; the engine picker lives in
// ./create-store.ts (main entry, PGlite dev default via #store/db) and
// ./postgres.ts (pg only), so no engine module may be imported here.
import type { Db, StoreConfig } from "./db-postgres.js";
import { createRecordStore } from "./records.js";
import { createReservedRecordStore } from "./routing.js";
import { ensureSchema as migrateSchema } from "./schema.js";

/** 02-store §1 */
export interface VendoStore extends StoreAdapter {
  ensureSchema(): Promise<void>;
  close(): Promise<void>;
  raw(): unknown;
  /** The 42-op named-operation surface, when this store carries one (the Cloud
   *  hosted store does; a local store's lives behind `createStoreOps`). It is
   *  what lets the helpers that need a transcript, a workspace or harness state
   *  serve a store with no SQL handle — see `backendOf`. */
  ops?: StoreOps;
}

/** Per-handle internals kept OFF the public store object (02-store §4 keeps
 *  the encryption key out of reach of anything holding the store). */
interface StoreInternals {
  db: Db;
  encryptionKey: Buffer | undefined;
  allowPlaintextSecrets: boolean;
}

const internals = new WeakMap<object, StoreInternals>();

export function dbFor(store: VendoStore): Db {
  const found = internals.get(store);
  if (!found) throw new Error("Unknown VendoStore handle");
  return found.db;
}

/** The SQL handle behind a store, or `undefined` when this handle is not one
 *  this package minted — a hosted store, or a host's own adapter. The asking
 *  form of `dbFor`, for the callers that have a second way to serve the read
 *  (`backendOf`) instead of nothing to say but "unknown handle". */
export function maybeDbFor(store: VendoStore): Db | undefined {
  return internals.get(store)?.db;
}

/** Package-internal (secrets.ts): the secrets configuration bound to a store
 *  handle. A closed (or unknown) handle reads as no key and no plaintext
 *  allowance, so secret access fails closed. */
export function secretsConfigFor(store: VendoStore): Pick<StoreInternals, "encryptionKey" | "allowPlaintextSecrets"> {
  return internals.get(store) ?? { encryptionKey: undefined, allowPlaintextSecrets: false };
}

/** 02-store §1 — assemble a VendoStore over an already-picked Db engine. The
 *  composition rung under the zero-config `createStore` fronts (./create-store.ts,
 *  ./postgres.ts), for hosts that own their connection: a pooler-backed handle, a
 *  transaction-scoped one, a Db spread over another (`{ ...db, query }`).
 *  Two things the caller now owns: `store.close()` closes the Db it was given, and
 *  `withSchemaLock` is the caller's to implement — a handle that cannot hold a
 *  session-scoped lock must THROW there rather than no-op, or two concurrent
 *  migrators both run the schema's data-moving backfills. */
export function createStoreForDb(
  db: Db,
  config: Pick<StoreConfig, "encryption" | "allowUnencryptedSecrets"> = {},
): VendoStore {
  const encryptionKey = config.encryption ? validateEncryptionKey(config.encryption.key) : undefined;
  const store: VendoStore = {
    records(collection: string): RecordStore {
      return createReservedRecordStore(db, collection) ?? createRecordStore(db, collection);
    },
    blobs(namespace: string): BlobStore {
      return createBlobStore(db, namespace);
    },
    async ensureSchema() {
      await migrateSchema(db);
    },
    async close() {
      internals.delete(store);
      await db.close();
    },
    raw() {
      return db.raw();
    },
  };
  internals.set(store, {
    db,
    encryptionKey,
    allowPlaintextSecrets: encryptionKey === undefined && config.allowUnencryptedSecrets === true,
  });
  return store;
}
