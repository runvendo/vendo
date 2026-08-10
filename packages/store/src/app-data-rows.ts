import {
  APP_DATA_COLLECTION_PATTERN,
  VendoError,
  type AppDataTarget,
  type BlobStore,
  type RecordInput,
  type RecordQuery,
  type VendoRecord,
} from "@vendoai/core";
import type { Db } from "./db.js";
import { jsonParam } from "./helpers/utils.js";
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
  // The appId goes into the name unescaped, and `appScopeId` parses it back on
  // the assumption that segment is colon-free. A colon in the appId collapses
  // two different drawers onto one string: appId "a:box" + collection "evil"
  // and appId "a" + collection "box:evil" both spell `app:a:box:evil`.
  if (target.appId === "" || target.appId.includes(":")) {
    invalid(`app data appId ${JSON.stringify(target.appId)} must be non-empty and free of ":"`);
  }
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
  const collection = appDataCollection(target);
  const records = createRecordStore(db, collection);
  const stamp = { [APP_DATA_OWNER_REF]: target.owner };

  return {
    /** An id another owner holds is a `conflict`, not an overwrite:
     *  `records.put` is an unconditional upsert on (collection, id), so without
     *  this a caller could destroy and re-stamp a row it can neither read nor
     *  delete. The refusal never names the holder — it only says the id is
     *  taken, which is all a caller who cannot see the row may learn.
     *
     *  Race-free rather than check-then-write: the insert decides the create
     *  atomically, and when it loses, `FOR UPDATE` locks the row that beat it,
     *  so a concurrent writer blocks instead of interleaving. That lock lives
     *  until COMMIT, so this needs a transaction-scoped handle (ops.ts hands
     *  one in) — a bare `BEGIN` is READ COMMITTED, where an unlocked read would
     *  see a snapshot the following write does not honor. */
    async put(record) {
      refuseCallerOwner(record.refs);
      const stamped = { ...record, refs: { ...record.refs, ...stamp } };
      const created = await records.atomic!.insertIfAbsent(stamped);
      if (created !== null) return created;

      const held = await db.query(
        "SELECT refs FROM vendo_records WHERE collection = $1 AND id = $2 FOR UPDATE",
        [collection, record.id],
      );
      const row = held.rows[0];
      // No row means the holder deleted it while we looked; the upsert below
      // recreates it as ours.
      if (row !== undefined
        && (row["refs"] as Record<string, string> | null)?.[APP_DATA_OWNER_REF] !== target.owner) {
        throw new VendoError(
          "conflict",
          `app data id ${JSON.stringify(record.id)} is already held in this collection`,
        );
      }
      return await records.put(stamped);
    },

    async get(id) {
      const record = await records.get(id);
      return record?.refs?.[APP_DATA_OWNER_REF] === target.owner ? record : null;
    },

    async list(query = {}) {
      refuseCallerOwner(query.refs);
      return await records.list({
        ...query,
        refs: { ...query.refs, [APP_DATA_OWNER_REF]: target.owner },
      });
    },

    /** ONE owner-predicated statement, so a foreign row survives with no window
     *  to race — a read-then-delete has one, because `createRecordStore.delete`
     *  carries no owner predicate and would delete a row that changed hands
     *  between the two statements. That missing predicate is why the composer
     *  reaches the table directly here instead of going through the door.
     *  `refs @> …` rides the same GIN index the scoped read does, and the
     *  door's skipped `requireKnownApp` pre-check was only an error signal — a
     *  delete never creates rows. */
    async delete(id) {
      await db.query(
        "DELETE FROM vendo_records WHERE collection = $1 AND id = $2 AND refs @> $3::jsonb",
        [collection, id, jsonParam(stamp)],
      );
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
