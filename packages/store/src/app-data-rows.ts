import {
  APP_DATA_COLLECTION_PATTERN,
  type AppDataTarget,
  type BlobStore,
  type RecordInput,
  type RecordQuery,
  type VendoRecord,
} from "@vendoai/core";
import type { Db } from "./db.js";
import { createRecordStore } from "./records.js";
import type { VendoStore } from "./store.js";
import { invalid } from "./validate.js";

/** The ref key the owner stamp rides. Deliberately a REF and not a column: the
 *  erase cascade already sweeps stamped rows (`refs @> $1::jsonb`) and the GIN
 *  index on `refs` already serves the scoped read, so appData needs no schema
 *  of its own. */
export const APP_DATA_OWNER_REF = "subject";

/** The one place in this package that spells an appData name. Rows land in
 *  `app:<appId>:<collection>` and their file twins in the blob namespace of the
 *  same shape, which is what keeps `eraseStore().byApp`'s
 *  `namespace LIKE 'app:<appId>:%'` sweeping both with the app. */
export function appDataCollection(target: AppDataTarget): string {
  if (target.appId === "") invalid("app data needs an appId");
  if (!APP_DATA_COLLECTION_PATTERN.test(target.collection)) {
    invalid(
      `app data collection ${JSON.stringify(target.collection)} is not a legal name`
      + ` (letters, digits, "_" and "-", up to 64, optionally "box:"-prefixed)`,
    );
  }
  return `app:${target.appId}:${target.collection}`;
}

/** The blob twin of {@link appDataCollection} — the same string, by design. */
export function appDataNamespace(target: AppDataTarget): string {
  return appDataCollection(target);
}

/** Files carry no refs, so their owner rides the key instead of a stamp. */
export function appDataFileKey(owner: string, key: string): string {
  return `${owner}/${key}`;
}

/** A caller who supplies `refs.subject` is writing (or reading) as someone
 *  else. Refused, never silently overwritten with the real owner — and refused
 *  BEFORE anything is written, so a refused put leaves no row. */
export function refuseCallerOwner(refs: Record<string, string> | undefined): void {
  if (refs?.[APP_DATA_OWNER_REF] !== undefined) {
    invalid(
      `app data may not supply refs.${APP_DATA_OWNER_REF};`
      + " the runtime stamps the owner from the host's session",
    );
  }
}

/** Row-level access to one app+collection drawer, scoped to one owner: writes
 *  are stamped with it and reads are filtered by it, so no verb here takes a
 *  subject. */
export interface AppDataRows {
  put(record: RecordInput): Promise<VendoRecord>;
  get(id: string): Promise<VendoRecord | null>;
  list(query?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
  delete(id: string): Promise<void>;
}

export function appDataRows(db: Db, target: AppDataTarget): AppDataRows {
  const records = createRecordStore(db, appDataCollection(target));
  const owned = (record: VendoRecord | null): boolean =>
    record?.refs?.[APP_DATA_OWNER_REF] === target.owner;

  return {
    async put(record) {
      refuseCallerOwner(record.refs);
      return await records.put({
        ...record,
        refs: { ...record.refs, [APP_DATA_OWNER_REF]: target.owner },
      });
    },

    async get(id) {
      const record = await records.get(id);
      return owned(record) ? record : null;
    },

    async list(query = {}) {
      refuseCallerOwner(query.refs);
      return await records.list({
        ...query,
        refs: { ...query.refs, [APP_DATA_OWNER_REF]: target.owner },
      });
    },

    /** Read-then-check, so a foreign row survives. Both statements go through
     *  the `db` handed in — hand this a transaction-scoped handle and the check
     *  and the delete are ONE transaction, which is the only way the row cannot
     *  change owner between them. */
    async delete(id) {
      if (!owned(await records.get(id))) return;
      await records.delete(id);
    },
  };
}

/** The file twins of one owner's drawer: a BlobStore whose keys are the
 *  caller's own, with `<owner>/` put on and taken off at the seam. The `list`
 *  prefix is therefore relative to the caller's key space — it is concatenated
 *  onto the owner leg before the query, not filtered after the strip. */
export function appDataFiles(store: VendoStore, target: AppDataTarget): BlobStore {
  const blobs = store.blobs(appDataNamespace(target));
  const owned = (key: string): string => appDataFileKey(target.owner, key);

  return {
    async put(key, bytes, meta) {
      await blobs.put(owned(key), bytes, meta);
    },
    async get(key) {
      return await blobs.get(owned(key));
    },
    async delete(key) {
      await blobs.delete(owned(key));
    },
    async list(prefix = "") {
      const keys = await blobs.list(owned(prefix));
      return keys.map((key) => key.slice(target.owner.length + 1));
    },
  };
}
