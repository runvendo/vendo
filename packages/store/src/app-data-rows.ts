import {
  APP_DATA_COLLECTION_PATTERN,
  APP_DATA_OWNER_PATTERN,
  VendoError,
  type AppDataTarget,
  type BlobStore,
  type RecordInput,
  type RecordQuery,
  type VendoRecord,
} from "@vendoai/core";
import type { Db } from "./db.js";
import { jsonParam, requireKnownApp } from "./helpers/utils.js";
import { createRecordStore, recordFromRow } from "./records.js";
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

/** The owner leg of a target, checked. Every verb composes it, because an
 *  owner outside the grammar is refused rather than repaired: rewriting one
 *  would land two different people in one drawer. */
export function appDataOwner(owner: string): string {
  if (!APP_DATA_OWNER_PATTERN.test(owner)) {
    invalid(`app data owner ${JSON.stringify(owner)} must be non-empty and free of "/"`);
  }
  return owner;
}

/** Files carry no refs, so their owner rides the key instead of a stamp — which
 *  is exactly why {@link appDataOwner} exists: `<owner>/<key>` cannot tell
 *  owner "a/b" apart from owner "a" writing "b/…". */
export function appDataFileKey(owner: string, key: string): string {
  return `${appDataOwner(owner)}/${key}`;
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
  const stamp = { [APP_DATA_OWNER_REF]: appDataOwner(target.owner) };

  return {
    /** An id another owner holds is a `conflict`, not an overwrite:
     *  `records.put` is an unconditional upsert on (collection, id), so without
     *  a predicate a caller could destroy and re-stamp a row it can neither
     *  read nor delete. The refusal never names the holder — it only says the
     *  id is taken, which is all a caller who cannot see the row may learn.
     *
     *  ONE owner-predicated statement, like `delete` below, because a
     *  read-then-write cannot express this: `SELECT … FOR UPDATE` locks NOTHING
     *  when the row is absent, so a holder deleting the id while a third owner
     *  recreates it leaves both racers seeing "absent" and both upserting, and
     *  the loser's row is destroyed and re-stamped. Here the arbitration is the
     *  database's — `ON CONFLICT … DO UPDATE` takes the conflicting row's lock
     *  BEFORE it evaluates its `WHERE`, so a foreign holder makes the whole
     *  statement touch no rows. The in-statement `vendo_apps` gate is the same
     *  one `createRecordStore` carries on every row-creating write. */
    async put(record) {
      refuseCallerOwner(record.refs);
      // Pre-check for the clean unknown-app signal; the statement's own gate is
      // the structural guarantee (a gate lost to a racing sweep writes nothing).
      await requireKnownApp(db, target.appId);
      const now = new Date().toISOString();
      const result = await db.query(
        `INSERT INTO vendo_records (collection, id, data, refs, created_at, updated_at, revision)
         SELECT $1::text, $2::text, $3::jsonb, $4::jsonb, $5::timestamptz, $5::timestamptz, 1
         WHERE EXISTS (SELECT 1 FROM vendo_apps WHERE id = $6)
         ON CONFLICT (collection, id) DO UPDATE
           SET data = EXCLUDED.data, refs = EXCLUDED.refs, updated_at = EXCLUDED.updated_at,
               revision = vendo_records.revision + 1
           WHERE vendo_records.refs @> $7::jsonb
         RETURNING id, data, refs, created_at, updated_at, revision`,
        [
          collection,
          record.id,
          jsonParam(record.data),
          jsonParam({ ...record.refs, ...stamp }),
          now,
          target.appId,
          jsonParam(stamp),
        ],
      );
      const row = result.rows[0];
      if (row !== undefined) return recordFromRow(row);
      // Nothing was written, so the outcome is already decided and this read
      // only picks WHICH refusal to report: the app vanished under the
      // pre-check, or the id belongs to someone else.
      await requireKnownApp(db, target.appId);
      throw new VendoError(
        "conflict",
        `app data id ${JSON.stringify(record.id)} is already held in this collection`,
      );
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
  const owner = appDataOwner(target.owner);
  const owned = (key: string): string => appDataFileKey(owner, key);

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
      return keys.map((key) => key.slice(owner.length + 1));
    },
  };
}
