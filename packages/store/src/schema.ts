import { VendoError } from "@vendoai/core";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { withSchemaLock } from "./db.js";

/** 02-store §4 */
export const SCHEMA_VERSION = 2;

/** 02-store §2 */
export const DDL = [
  `CREATE TABLE IF NOT EXISTS vendo_apps (
    id text PRIMARY KEY, subject text NOT NULL, enabled boolean NOT NULL DEFAULT true,
    doc jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_apps_subject_idx ON vendo_apps (subject)",
  `CREATE TABLE IF NOT EXISTS vendo_records (
    collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL, refs jsonb,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (collection, id)
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_records_refs_idx ON vendo_records USING GIN (refs jsonb_path_ops)",
  `CREATE TABLE IF NOT EXISTS vendo_blobs (
    namespace text NOT NULL, key text NOT NULL, bytes bytea NOT NULL, content_type text,
    created_at timestamptz NOT NULL, PRIMARY KEY (namespace, key)
  )`,
  `CREATE TABLE IF NOT EXISTS vendo_state (
    app_id text NOT NULL, subject text NOT NULL, data jsonb NOT NULL,
    updated_at timestamptz NOT NULL, PRIMARY KEY (app_id, subject)
  )`,
  `CREATE TABLE IF NOT EXISTS vendo_threads (
    id text PRIMARY KEY, subject text NOT NULL, messages jsonb NOT NULL,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_threads_subject_idx ON vendo_threads (subject)",
  `CREATE TABLE IF NOT EXISTS vendo_grants (
    id text PRIMARY KEY, subject text NOT NULL, tool text NOT NULL, descriptor_hash text NOT NULL,
    scope jsonb NOT NULL, duration text NOT NULL, context_key text, app_id text, source text NOT NULL,
    granted_at timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_grants_subject_tool_idx ON vendo_grants (subject, tool)",
  `CREATE TABLE IF NOT EXISTS vendo_approvals (
    id text PRIMARY KEY, subject text NOT NULL, request jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending', decided_at timestamptz, session_id text,
    consumed_at timestamptz, created_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_approvals_subject_status_idx ON vendo_approvals (subject, status)",
  `CREATE TABLE IF NOT EXISTS vendo_audit (
    id text PRIMARY KEY, at timestamptz NOT NULL, kind text NOT NULL, subject text NOT NULL,
    venue text NOT NULL, presence text NOT NULL, app_id text, tool text, event jsonb NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_audit_subject_at_idx ON vendo_audit (subject, at)",
  "CREATE INDEX IF NOT EXISTS vendo_audit_at_idx ON vendo_audit (at)",
  `CREATE TABLE IF NOT EXISTS vendo_runs (
    id text PRIMARY KEY, app_id text NOT NULL, trigger jsonb NOT NULL, status text NOT NULL,
    record jsonb NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_runs_app_started_idx ON vendo_runs (app_id, started_at)",
  `CREATE TABLE IF NOT EXISTS vendo_secrets (
    name text PRIMARY KEY, ciphertext text NOT NULL, created_at timestamptz NOT NULL
  )`,
] as const;

// Additive columns stay compatible with same-version development databases (02 §2
// allows additive columns within the version train; key columns are untouched).
// vendo_state gains a stable record id (generated from the app_id:subject PK, so
// point lookups hit an index instead of seq-scanning) and its own created_at, so
// the seam can expose a creation timestamp that survives updates.
const ADDITIVE_DDL = [
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS session_id text",
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz",
  "ALTER TABLE vendo_state ADD COLUMN IF NOT EXISTS id text GENERATED ALWAYS AS (app_id || ':' || subject) STORED",
  "ALTER TABLE vendo_state ADD COLUMN IF NOT EXISTS created_at timestamptz",
  "CREATE INDEX IF NOT EXISTS vendo_state_id_idx ON vendo_state (id)",
] as const;

// v2 backfill (runs once, only when upgrading from a version < 2 — 02 §4 keys
// migrations by vendo_meta.schema_version, forward-only). Three moves:
//   1. Relocate legacy vendo_state singletons that a pre-fix deployment wrote into
//      vendo_records (collection 'vendo_state', id `${app_id}:${subject}`) into the
//      dedicated table. App ids are colon-free (`^app_[^:]*$`), so the FIRST colon
//      splits id into app_id + subject unambiguously; the `id ~ '^app_[^:]*:'`
//      predicate relocates only rows whose leading segment is a real app id — the
//      SAME shape the state door (splitStateId) enforces. Anything else (colon-less
//      rows, or ids whose first segment is not app-shaped) SURVIVES in vendo_records
//      rather than being silently destroyed or misrouted.
//   2. The DELETE is scoped to the identical predicate as the INSERT — only the rows
//      actually relocated are removed.
//   3. Both write doors were live pre-fix (stateStore wrote the dedicated table, the
//      seam wrote vendo_records), so a legacy row can be NEWER than an existing
//      dedicated row. Resolve by timestamp (`WHERE vendo_state.updated_at <
//      EXCLUDED.updated_at`) so the newer write wins instead of DO NOTHING dropping it.
//   4. Backfill created_at for state rows that predate the created_at column.
const DATA_BACKFILL = [
  `INSERT INTO vendo_state (app_id, subject, data, updated_at)
   SELECT split_part(id, ':', 1), substring(id FROM position(':' IN id) + 1), data, updated_at
   FROM vendo_records WHERE collection = 'vendo_state' AND id ~ '^app_[^:]*:'
   ON CONFLICT (app_id, subject) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
     WHERE vendo_state.updated_at < EXCLUDED.updated_at`,
  "DELETE FROM vendo_records WHERE collection = 'vendo_state' AND id ~ '^app_[^:]*:'",
  "UPDATE vendo_state SET created_at = updated_at WHERE created_at IS NULL",
] as const;

type Query = Db["query"];

async function migrate(query: Query): Promise<void> {
  await query("CREATE TABLE IF NOT EXISTS vendo_meta (key text PRIMARY KEY, value jsonb NOT NULL)");
  const result = await query("SELECT value FROM vendo_meta WHERE key = 'schema_version'");
  const value = result.rows[0]?.["value"];
  const version = typeof value === "number" ? value : undefined;
  if (version !== undefined && version > SCHEMA_VERSION) {
    throw new VendoError(
      "conflict",
      `Store schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
  const upgrading = version === undefined || version < SCHEMA_VERSION;
  if (upgrading) {
    for (const statement of DDL) await query(statement);
    await query(
      `INSERT INTO vendo_meta (key, value) VALUES ('schema_version', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(SCHEMA_VERSION)],
    );
  }
  // Additive columns are safe to re-apply every run (IF NOT EXISTS); they keep
  // same-version development databases compatible without a version bump.
  for (const statement of ADDITIVE_DDL) await query(statement);
  // The v2 backfill is destructive-adjacent (it DELETEs from vendo_records), so it
  // runs ONLY while upgrading past its version — never unconditionally, or a newer
  // vendo_records write in a mixed-version deploy would be repeatedly relocated/lost.
  if (upgrading) {
    for (const statement of DATA_BACKFILL) await query(statement);
  }
  await query(
    `INSERT INTO vendo_meta (key, value) VALUES ('boot_id', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(randomUUID())],
  );
}

/** 02-store §4 */
export async function ensureSchema(db: Db): Promise<void> {
  await withSchemaLock(db, migrate);
}
