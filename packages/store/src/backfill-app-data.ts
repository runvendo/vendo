import { APP_DATA_OWNER_REF } from "./app-data-rows.js";
import type { Db } from "./db.js";
import { appScopeId, escapeLike, jsonParam } from "./helpers/utils.js";
import { dbFor, type VendoStore } from "./store.js";

/** Every appData read is auto-scoped to the caller's owner — `refs.subject` on
 *  rows, an `<owner>/` leading key leg on their file twins. A row written
 *  before a door moved onto the family carries neither, so the moment that door
 *  flips the row goes INVISIBLE: not deleted, unreadable. This module is the
 *  one-shot migration that stamps that data with the owner it always had, and
 *  it is the only thing between a flip and silent data loss. Correctness over
 *  cleverness throughout: where an owner cannot be established the backfill
 *  reports and moves on, and it issues no DELETE anywhere. */

export interface AppDataBackfillReport {
  apps: number;
  rowsStamped: number;
  rowsSkipped: number;
  filesMoved: number;
  orphanCollections: string[];
}

const DEFAULT_BATCH = 500;

/** One app's appData names, rows and files alike — `appDataNamespace` IS
 *  `appDataCollection`, so a single pattern selects both tables' share. */
function appScopePrefix(appId: string): string {
  return `app:${escapeLike(appId)}:%`;
}

/** The app-scoped names present in one table, mapped to their owning appId.
 *  A name `appScopeId` cannot parse (a bare `app:<id>` namespace, no collection
 *  segment) is not an appData name at all: it is dropped here, so nothing
 *  downstream touches or reports it. */
async function discoverNames(
  db: Db,
  table: "vendo_records" | "vendo_blobs",
  column: "collection" | "namespace",
  appId: string | undefined,
): Promise<Map<string, string>> {
  const result = appId === undefined
    ? await db.query(`SELECT DISTINCT ${column} FROM ${table} WHERE ${column} LIKE 'app:%'`)
    : await db.query(
      `SELECT DISTINCT ${column} FROM ${table} WHERE ${column} LIKE $1 ESCAPE '\\'`,
      [appScopePrefix(appId)],
    );
  const names = new Map<string, string>();
  for (const row of result.rows) {
    const name = String(row[column]);
    const owningApp = appScopeId(name);
    if (owningApp !== undefined) names.set(name, owningApp);
  }
  return names;
}

/** Rows in `collection` that already carry an owner stamp — counted BEFORE
 *  stamping, or the run's own work would report itself as pre-existing. */
async function countStamped(db: Db, collection: string): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS stamped FROM vendo_records
     WHERE collection = $1 AND refs->>'${APP_DATA_OWNER_REF}' IS NOT NULL`,
    [collection],
  );
  return Number(result.rows[0]?.["stamped"] ?? 0);
}

/** Merge the owner stamp into `refs` and NOTHING else: `data`, `updated_at` and
 *  `revision` stay exactly as they were. The row's content did not change, and
 *  bumping `revision` would fail a live CAS holder for a change it cannot see. */
async function stampRows(db: Db, collection: string, owner: string, batch: number): Promise<number> {
  const stamp = jsonParam({ [APP_DATA_OWNER_REF]: owner });
  let stamped = 0;
  for (;;) {
    const result = await db.query(
      `UPDATE vendo_records SET refs = coalesce(refs, '{}'::jsonb) || $2::jsonb
       WHERE (collection, id) IN (
         SELECT collection, id FROM vendo_records
         WHERE collection = $1 AND refs->>'${APP_DATA_OWNER_REF}' IS NULL
         ORDER BY id LIMIT $3
       ) RETURNING 1`,
      [collection, stamp, batch],
    );
    if (result.rows.length === 0) return stamped;
    stamped += result.rows.length;
  }
}

/** Put the owner leg on legacy file keys. Already-migrated keys are recognised
 *  by `key LIKE '<owner>/%'` and nothing else, which carries a residual
 *  ambiguity worth naming: a legacy key that literally begins with `<owner>/`
 *  is indistinguishable from one this backfill already moved, so it is left
 *  alone. Each batch's rows join that prefixed set, leaving the candidate set
 *  as they go, so the loop still ends on a zero-row batch.
 *
 *  `(namespace, key)` is the primary key, so a collision with an existing
 *  `<owner>/<key>` raises a unique violation. It is allowed to throw: the
 *  backfill never invents a resolution, exactly like the orphan rule. */
async function moveFiles(db: Db, namespace: string, owner: string, batch: number): Promise<number> {
  const alreadyOwned = `${escapeLike(owner)}/%`;
  let moved = 0;
  for (;;) {
    const result = await db.query(
      `UPDATE vendo_blobs SET key = $2 || '/' || key
       WHERE (namespace, key) IN (
         SELECT namespace, key FROM vendo_blobs
         WHERE namespace = $1 AND key NOT LIKE $3 ESCAPE '\\' ORDER BY key LIMIT $4
       ) RETURNING 1`,
      [namespace, owner, alreadyOwned, batch],
    );
    if (result.rows.length === 0) return moved;
    moved += result.rows.length;
  }
}

/** The Db-taking implementation behind {@link backfillAppDataStamps}, so
 *  promote can run the stamp on its TRANSACTION-scoped handle (same reason as
 *  {@link reownAppData}). Package-internal: never exported from the package
 *  entries — a caller outside gets the store-taking verb. */
export async function backfillAppDataOnDb(
  db: Db,
  options: { batch?: number; appId?: string },
): Promise<AppDataBackfillReport> {
  const batch = options.batch ?? DEFAULT_BATCH;
  const collections = await discoverNames(db, "vendo_records", "collection", options.appId);
  const namespaces = await discoverNames(db, "vendo_blobs", "namespace", options.appId);

  // The owner of everything under `app:<appId>:…` is the app row's subject —
  // read once per app, with no personal-vs-promoted branch: a promoted app's
  // subject IS the org id (build contract §9.5), so the row already holds the
  // right value.
  const subjects = new Map<string, string>();
  const apps = options.appId === undefined
    ? await db.query("SELECT id, subject FROM vendo_apps")
    : await db.query("SELECT id, subject FROM vendo_apps WHERE id = $1", [options.appId]);
  for (const row of apps.rows) subjects.set(String(row["id"]), String(row["subject"]));

  const report: AppDataBackfillReport = {
    apps: 0,
    rowsStamped: 0,
    rowsSkipped: 0,
    filesMoved: 0,
    orphanCollections: [],
  };

  // Resolved over the UNION of both tables' names, so a name discovered on both
  // sides is reported as an orphan once, not twice.
  const owners = new Map<string, string>();
  const worked = new Set<string>();
  for (const [name, appId] of new Map([...collections, ...namespaces])) {
    const subject = subjects.get(appId);
    // No app row, an empty subject, or a subject carrying the `/` that
    // separates the owner leg from the caller's key: an owner that cannot be
    // determined — or cannot be USED safely — is never guessed at. Reported,
    // and left completely untouched. `vendo_apps.subject` is host-chosen, and
    // an owner with a slash writes a key another owner can read back (owner
    // `own_a/sub` and owner `own_a`'s key `sub/x.bin` spell the same row), so
    // stamping one bends data no later door fix can unbend. Neither sanitised
    // nor rewritten: `/` is the only thing matched here, because the owner
    // grammar itself is being decided elsewhere.
    if (subject === undefined || subject === "" || subject.includes("/")) {
      report.orphanCollections.push(name);
      continue;
    }
    owners.set(name, subject);
    worked.add(appId);
  }

  for (const [collection] of collections) {
    const owner = owners.get(collection);
    if (owner === undefined) continue;
    report.rowsSkipped += await countStamped(db, collection);
    report.rowsStamped += await stampRows(db, collection, owner, batch);
  }
  for (const [namespace] of namespaces) {
    const owner = owners.get(namespace);
    if (owner === undefined) continue;
    report.filesMoved += await moveFiles(db, namespace, owner, batch);
  }
  report.apps = worked.size;
  return report;
}

/**
 * Stamp pre-existing appData with the owner it always had, so the auto-scoped
 * read path can still see it: rows get `refs.<APP_DATA_OWNER_REF>`, file twins
 * get the `<owner>/` key leg. Re-runnable by construction — a second run stamps
 * 0 rows and moves 0 files, and reports the already-stamped rows as
 * `rowsSkipped`.
 *
 * `apps` counts the apps this run actually WORKED ON: those owning at least one
 * discovered, non-orphan appData collection or namespace. `orphanCollections`
 * holds the names whose owner could not be established (no `vendo_apps` row, or
 * an empty subject); nothing in them is touched, and this function never
 * deletes anything.
 */
export async function backfillAppDataStamps(
  store: VendoStore,
  options: { batch?: number; appId?: string } = {},
): Promise<AppDataBackfillReport> {
  return await backfillAppDataOnDb(dbFor(store), options);
}

/** The two generic-table collections that wrote their app ref under `appId`
 *  instead of the `app_id` every other writer (and the erase cascade) uses. */
const APP_REF_KEY_COLLECTIONS = ["vendo_inclient_approvals", "vendo_remix_rejections"] as const;

export interface AppRefKeyBackfillReport {
  /** Rows whose `refs.appId` became `refs.app_id` on this run. */
  rowsRenamed: number;
  /** Rows already carrying `app_id` — counted BEFORE the rename, so a run never
   *  reports its own work as pre-existing. A second run renames 0 and skips
   *  everything the first one fixed. */
  rowsSkipped: number;
}

/**
 * In-client approvals and remix rejections wrote their app ref as `refs.appId`;
 * the erase cascade's byApp leg matches `refs @> {"app_id": …}`, so those rows
 * were never swept with their app and outlived it permanently. The writers now
 * spell `app_id`; this renames the key on the rows already on disk.
 *
 * Re-runnable by construction — the selector excludes anything that already
 * carries `app_id`, so a second run reports `rowsRenamed: 0`. `data` is
 * untouched and no row is ever deleted; only the ref KEY moves, so a live
 * reader sees the same app id under the name every other collection uses.
 */
export async function backfillAppRefKey(store: VendoStore): Promise<AppRefKeyBackfillReport> {
  const db = dbFor(store);
  const collections = [...APP_REF_KEY_COLLECTIONS];
  const skipped = await db.query(
    `SELECT count(*)::int AS skipped FROM vendo_records
     WHERE collection = ANY($1::text[]) AND refs ? 'app_id'`,
    [collections],
  );
  const renamed = await db.query(
    `UPDATE vendo_records
     SET refs = (refs - 'appId') || jsonb_build_object('app_id', refs->>'appId')
     WHERE collection = ANY($1::text[]) AND refs ? 'appId' AND NOT refs ? 'app_id'
     RETURNING 1`,
    [collections],
  );
  return {
    rowsRenamed: renamed.rows.length,
    rowsSkipped: Number(skipped.rows[0]?.["skipped"] ?? 0),
  };
}

/** Promote's half: the whole app changes hands, so every appData row and file
 *  stamped `from` is re-stamped `to`. Takes a Db (not a store) so promote can
 *  pass its TRANSACTION-scoped handle — a base-handle query issued mid
 *  transaction deadlocks PGlite's single connection (see ops.ts's txDb note). */
export async function reownAppData(db: Db, appId: string, from: string, to: string): Promise<void> {
  const prefix = appScopePrefix(appId);
  await db.query(
    `UPDATE vendo_records SET refs = refs || $2::jsonb
     WHERE collection LIKE $1 ESCAPE '\\' AND refs @> $3::jsonb`,
    [prefix, jsonParam({ [APP_DATA_OWNER_REF]: to }), jsonParam({ [APP_DATA_OWNER_REF]: from })],
  );
  await db.query(
    // SQL `substring(… from n)` is 1-indexed, so the caller's own key starts one
    // past the `<from>/` leg: from.length + 2. The `::int` is load-bearing: an
    // untyped parameter there resolves to `substring(text from PATTERN)`, the
    // POSIX-regex overload, which finds no match and sets every key to NULL.
    `UPDATE vendo_blobs SET key = $2 || '/' || substring(key from $3::int)
     WHERE namespace LIKE $1 ESCAPE '\\' AND key LIKE $4 ESCAPE '\\'`,
    [prefix, to, from.length + 2, `${escapeLike(from)}/%`],
  );
}
