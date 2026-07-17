import type { BlobStore, RecordStore, StoreAdapter } from "@vendoai/core";
import { createBlobStore } from "./blobs.js";
import { dropEncryptionKey, setEncryptionKey, validateEncryptionKey } from "./crypto.js";
import { createDb, type Db, type StoreConfig } from "./db.js";
import { createRecordStore } from "./records.js";
import { createReservedRecordStore } from "./routing.js";
import { ensureSchema as migrateSchema } from "./schema.js";

/** 02-store §1 */
export interface VendoStore extends StoreAdapter {
  ensureSchema(): Promise<void>;
  close(): Promise<void>;
  raw(): unknown;
}

const databases = new WeakMap<object, Db>();

export function dbFor(store: VendoStore): Db {
  const db = databases.get(store);
  if (!db) throw new Error("Unknown VendoStore handle");
  return db;
}

/** 02-store §1 */
export function createStore(config: StoreConfig = {}): VendoStore {
  const encryptionKey = config.encryption ? validateEncryptionKey(config.encryption.key) : undefined;
  const db = createDb(config);
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
      dropEncryptionKey(store);
      databases.delete(store);
      await db.close();
    },
    raw() {
      return db.raw();
    },
  };
  databases.set(store, db);
  setEncryptionKey(store, encryptionKey);
  return store;
}
