import { assertEngineCollection, VendoError, type StoreOps } from "@vendoai/core";
import type { Db } from "./db.js";
import {
  ageColumnOf,
  DEDICATED_RECORD_COLLECTIONS,
  RESERVED_COLLECTIONS,
  type ReservedCollection,
} from "./routing.js";

/** The collections a sweep will not touch, because their rows are not the
 *  whole of what they own and lifting the row alone would leave the rest
 *  stranded in the live database with nothing left pointing at it:
 *
 *   · `vendo_threads` — the transcript lives in `vendo_thread_messages`, and the
 *     row itself carries the conversation's harness state in its `harness_state`
 *     column (`deleteThread` is a two-table cascade, ops.ts).
 *   · `vendo_apps` — an app row owns an entire drawer (its records, blobs,
 *     state and grants), and `createRecordStore`'s app gate refuses writes the
 *     moment the row is gone, so a lifted app leaves rows nothing can read,
 *     write, or erase.
 *   · `vendo_automations` — a run row names only its automation, so the erase
 *     cascade reaches runs by joining to this table (erase.ts). Lifting an
 *     automation row breaks that join and its runs survive their owner's
 *     erasure — the very thing a sweep must never become.
 *
 *  Refused rather than half-swept: a quarantine's whole promise is that what it
 *  lifted is still whole. Ageing any of these out is `lifecycle.erase`'s job
 *  (or `transcripts.deleteThread`'s), and both say so. */
const NOT_SWEEPABLE: Record<string, string> = {
  vendo_threads: "its transcript lives in another table and its row carries a live conversation's harness state — delete a thread through transcripts.deleteThread, or erase the subject",
  vendo_apps: "an app row owns its whole drawer (records, blobs, grants) — remove an app through lifecycle.erase({ appId })",
  vendo_automations: "its runs are reachable only through it, so lifting it would leave them beyond the erase cascade — erase the subject instead",
};

/** Where one collection's live rows sit, and the whole of the sweep's WHERE:
 *  the collection's scope and the row's own age against the cutoff ($2).
 *
 *  Every routed table is swept whole now: a sweep sees exactly what the
 *  collection's door sees, because no table hides a second tenant behind a
 *  predicate any more. `vendo_state` was the one that did — an app's state at
 *  the door, a live conversation's harness continuity underneath it — and both
 *  are gone (harness state is a column on `vendo_threads`, which is refused for
 *  sweeping outright, above).
 *
 *  Table names are interpolated into SQL, so they come only from the frozen
 *  routing constants (footprint.ts' rule), never from the caller's string. A
 *  generic collection is a `collection = $1` scope inside `vendo_records`; a
 *  collection with a table of its own is the whole table. The age column is the
 *  door's own `cursorColumn`, read off the door's config rather than copied, so
 *  "older than" cannot come to mean one thing to a reader and another to a
 *  sweep. */
function liftFrom(db: Db, collection: string): { table: string; where: string } {
  const reserved = (RESERVED_COLLECTIONS as readonly string[]).includes(collection);
  const ownTable = reserved || (DEDICATED_RECORD_COLLECTIONS as readonly string[]).includes(collection);
  const age = reserved ? ageColumnOf(db, collection as ReservedCollection) : "created_at";
  return {
    table: ownTable ? collection : "vendo_records",
    where: [
      ...(ownTable ? [] : ["collection = $1"]),
      `${age} < $2::timestamptz`,
    ].join(" AND "),
  };
}

function assertSweepable(collection: string): void {
  assertEngineCollection(collection);
  const reason = NOT_SWEEPABLE[collection];
  if (reason !== undefined) {
    throw new VendoError("blocked", `${collection} rows cannot be quarantined: ${reason}`);
  }
}

/**
 * 01 §12 `StoreOps.retention` — ageing rows out of a collection in the two
 * moves a RECOVERABLE sweep takes. `quarantine` lifts rows past the window out
 * of the live collection into `vendo_quarantine` (schema.ts v9); `purge`
 * destroys what was lifted before its own cutoff. The gap between them is the
 * feature: a window that turns out to be wrong is recoverable right up until
 * the purge, which is the whole difference between this and a DELETE.
 *
 * The lift is ONE statement — a data-modifying CTE — so a row is never in both
 * places and never in neither, without a transaction to hold open across
 * however many million rows a first sweep moves.
 *
 * The lifted row is stored VERBATIM (`to_jsonb` of the live row, whatever its
 * table's shape), not as the door's `VendoRecord` projection: the projection is
 * lossy for several tables, and a quarantine that cannot put back exactly what
 * it took is a delete with a longer name.
 */
export function storeRetention(db: Db): NonNullable<StoreOps["retention"]> {
  return {
    async quarantine(collection, olderThan) {
      assertSweepable(collection);
      const { table, where } = liftFrom(db, collection);
      // `id` is read back out of the row's own jsonb rather than named per
      // table, because `vendo_effects` keys its rows `key` and everything else
      // keys them `id`. `subject`/`app_id` likewise: a typed door carries them
      // as columns, a generic row carries them in `refs`, and one COALESCE
      // reads both — a quarantined row the erase cascade cannot reach would
      // make this sweep a way to outlive an erasure.
      const result = await db.query(
        `WITH lifted AS (
           DELETE FROM ${table} WHERE ${where} RETURNING *
         ), lifted_rows AS (SELECT to_jsonb(lifted) AS data FROM lifted)
         INSERT INTO vendo_quarantine (collection, id, data, subject, app_id)
         SELECT $1, coalesce(data->>'id', data->>'key'), data,
                coalesce(data->>'subject', data->'refs'->>'subject'),
                coalesce(data->>'app_id', data->'refs'->>'app_id')
         FROM lifted_rows
         RETURNING 1`,
        [collection, olderThan],
      );
      return { moved: result.rows.length };
    },

    async purge(collection, quarantinedBefore) {
      // The same gate as the lift, so a collection that can never hold rows
      // here answers the same way to both verbs instead of silently reporting
      // zero destroyed.
      assertSweepable(collection);
      const result = await db.query(
        `DELETE FROM vendo_quarantine
         WHERE collection = $1 AND quarantined_at < $2::timestamptz RETURNING 1`,
        [collection, quarantinedBefore],
      );
      return { purged: result.rows.length };
    },
  };
}
