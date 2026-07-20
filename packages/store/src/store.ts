import type { BlobStore, RecordStore, StoreAdapter } from "@vendoai/core";
import { createBlobStore } from "./blobs.js";
import { validateEncryptionKey } from "./crypto.js";
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

/** Package-internal (secrets.ts): the secrets configuration bound to a store
 *  handle. A closed (or unknown) handle reads as no key and no plaintext
 *  allowance, so secret access fails closed. */
export function secretsConfigFor(store: VendoStore): Pick<StoreInternals, "encryptionKey" | "allowPlaintextSecrets"> {
  return internals.get(store) ?? { encryptionKey: undefined, allowPlaintextSecrets: false };
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
