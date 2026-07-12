import { VendoError } from "@vendoai/core";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { withSchemaLock } from "./db.js";

/** 02-store §4 */
export const SCHEMA_VERSION = 1;

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
    status text NOT NULL DEFAULT 'pending', decided_at timestamptz, created_at timestamptz NOT NULL
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
  if (version === undefined || version < SCHEMA_VERSION) {
    for (const statement of DDL) await query(statement);
    await query(
      `INSERT INTO vendo_meta (key, value) VALUES ('schema_version', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(SCHEMA_VERSION)],
    );
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
