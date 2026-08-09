import { VendoError } from "@vendoai/core";
// Type-only — erased at compile time, so this module stays engine-free and
// safe to share between the main entry and @vendoai/store/postgres.
import type { Db } from "./db-postgres.js";

/** 02-store §4. v3 (block-actions design §C, ENG-263) historically added the
    Vendo-owned org tables (`vendo_orgs` + `vendo_org_members`); those tables
    are cut under the simplify-v2 kill-list (docs/superpowers/specs/2026-07-16
    -simplify-v2-kill-list-design.md §A5) — orgs live on the Vendo-hosted side
    now. Existing dev databases that already have `vendo_orgs`/
    `vendo_org_members` keep those orphaned tables — erasing them is not
    required and this migration does not attempt it.

    v4 (kill-list §B3) adds `vendo_sessions`: the ephemeral in-memory overlay is
    gone, anonymous rows are ordinary disk rows, and this table is the session
    registry the TTL sweep reads (02 §4).

    v5 (ENG-356, knowledge design v2 (2026-07-22) R1) adds the dedicated
    knowledge record collections `vendo_knowledge_docs` / `vendo_knowledge_chunks`.
    Bumping the version is load-bearing, not cosmetic (review fix F1): the DDL
    loop runs only while `version < SCHEMA_VERSION`, so appending the tables
    WITHOUT this bump would leave every existing v4 database on 4 forever and the
    new tables would never be created.

    v6 (the embedded-agent build contract) is ONE bump carrying all four new
    tables — wave-1 lanes B and D landed together, so a database moves to v6
    once and gets the whole set:
      · `vendo_workspace_files` / `vendo_workspace_history` (§3.3) — the agent's
        filesystem as a façade over rows (documents are files, records stay
        tables), with a revision and an append-only history trail per path.
      · `vendo_thread_messages` (§6) — one row per transcript message, so a turn
        writes O(messages) instead of rewriting the whole array. `vendo_threads`
        LOSES `messages`; the v6 backfill splits every existing array into rows
        before dropping the column.
      · `vendo_effects` (§7) — the effect ledger that makes fail-and-re-run
        correct, keyed per (run, turn, tool, input, ordinal) and subject-scoped
        so it joins the erase cascade.
    Same load-bearing bump as v5 — the DDL loop only runs while
    version < SCHEMA_VERSION.

    v7 (build contract §9.2, wave 3) adds `vendo_app_grants`: app → principal →
    level, the ONLY multi-party rows Vendo stores. Memberships are asserted per
    request by the host's own identity system and are never persisted (§9.1),
    so this one table is the whole sharing model. Same load-bearing bump. */
export const SCHEMA_VERSION = 7;

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
    revision bigint NOT NULL DEFAULT 1,
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
  // v6 (build contract §6): the thread row is metadata only — `messages` moved
  // to vendo_thread_messages, one row per message.
  `CREATE TABLE IF NOT EXISTS vendo_threads (
    id text PRIMARY KEY, subject text NOT NULL,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_threads_subject_idx ON vendo_threads (subject)",
  // v6 (build contract §6): one row per UIMessage. `seq` is the ONLY ordering
  // authority — approval flips rewrite older messages, so timestamps cannot
  // order a transcript. `revision` is the per-row CAS counter for edits.
  `CREATE TABLE IF NOT EXISTS vendo_thread_messages (
    thread_id text NOT NULL, id text NOT NULL, seq integer NOT NULL,
    message jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, id)
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_thread_messages_thread_seq_idx ON vendo_thread_messages (thread_id, seq)",
  // v6 (build contract §7): the effect ledger. `key` is
  // sha256(runId + tool + exactInputHash); a key that already succeeded
  // returns its recorded outcome instead of executing a second time.
  // `subject` arrives with the 2026-07-30 contract amendment: `outcome` holds
  // real tool output, so the ledger has to be reachable by the erase cascade
  // and travel with an anon→signed-in adoption.
  `CREATE TABLE IF NOT EXISTS vendo_effects (
    key text PRIMARY KEY, subject text NOT NULL, outcome jsonb NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_effects_subject_idx ON vendo_effects (subject)",
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
    name text PRIMARY KEY, ciphertext text NOT NULL, created_at timestamptz NOT NULL,
    updated_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS vendo_mcp_clients (
    id text PRIMARY KEY, data jsonb NOT NULL, refs jsonb,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_mcp_clients_refs_idx ON vendo_mcp_clients USING GIN (refs jsonb_path_ops)",
  `CREATE TABLE IF NOT EXISTS vendo_mcp_grants (
    id text PRIMARY KEY, data jsonb NOT NULL, refs jsonb,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_mcp_grants_refs_idx ON vendo_mcp_grants USING GIN (refs jsonb_path_ops)",
  // 02-store §4 (kill-list B3): the ephemeral-session registry. One row per
  // live anonymous session; touched_at is the last-activity stamp the TTL
  // sweep compares against. Registration == touch (upsert).
  `CREATE TABLE IF NOT EXISTS vendo_sessions (
    subject text PRIMARY KEY, touched_at timestamptz NOT NULL
  )`,
  // 02-store §2 + knowledge design v2 (2026-07-22) R1 (ENG-356, v5): the
  // dedicated knowledge record collections. `vendo_knowledge_docs` is one row
  // per document-level corpus entry; `vendo_knowledge_chunks` is one row per
  // engine-minted chunk of a synced doc (the local engine's index — the cloud
  // engine keeps its corpus server-side and never populates these). Same
  // id/data/refs/created_at/updated_at layout as the MCP door tables; `refs`
  // carries the subject/app keys the erase cascade matches (§5).
  `CREATE TABLE IF NOT EXISTS vendo_knowledge_docs (
    id text PRIMARY KEY, data jsonb NOT NULL, refs jsonb,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_knowledge_docs_refs_idx ON vendo_knowledge_docs USING GIN (refs jsonb_path_ops)",
  `CREATE TABLE IF NOT EXISTS vendo_knowledge_chunks (
    id text PRIMARY KEY, data jsonb NOT NULL, refs jsonb,
    created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_knowledge_chunks_refs_idx ON vendo_knowledge_chunks USING GIN (refs jsonb_path_ops)",
  // Build contract §3.3 (v6): the workspace. One row per file, keyed
  // (path, owner). `owner` is a pure function of the path (§9.7): the subject
  // for `/user/**`, the org id for `/orgs/<orgId>/**`. (`/host/**` is a
  // per-turn projection the caller supplies, never rows.) Content is inline up
  // to WORKSPACE_INLINE_MAX_BYTES; past it (or when the bytes are not text) the
  // row carries a `blob_ref` into the files adapter instead. `revision` is the
  // per-file counter the /orgs compare-and-swap arms (wave 3) — it shipped in
  // v6 so the table never had to migrate for it.
  `CREATE TABLE IF NOT EXISTS vendo_workspace_files (
    path text NOT NULL, owner text NOT NULL, content text, blob_ref text,
    bytes integer NOT NULL, revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (path, owner)
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_workspace_files_owner_idx ON vendo_workspace_files (owner)",
  // Provenance. One row per superseded revision, carrying the content that
  // revision held and the consumer-voice `intent` of the write that replaced it
  // ("made the chart blue"). Retention: WORKSPACE_HISTORY_LIMIT rows per path.
  // The `content`/`blob_ref` columns are written but no longer read: nothing
  // restores a superseded revision now that undo is gone (see the changeset).
  `CREATE TABLE IF NOT EXISTS vendo_workspace_history (
    id text PRIMARY KEY, path text NOT NULL, owner text NOT NULL, revision integer NOT NULL,
    content text, blob_ref text, intent text, at timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_workspace_history_path_idx ON vendo_workspace_history (path, owner, revision DESC)",
  // Build contract §9.2 (v7): app-access grants. `principal` is one string in
  // the frozen encoding — `user:<subject>` · `team:<orgId>/<teamId>` ·
  // `org:<orgId>` — matched against the memberships the host ASSERTS per
  // request; nothing about the org chart is stored here. One row per
  // (app, principal): re-granting updates `level` in place.
  `CREATE TABLE IF NOT EXISTS vendo_app_grants (
    id text PRIMARY KEY, app_id text NOT NULL, org_id text NOT NULL,
    principal text NOT NULL, level text NOT NULL, created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (app_id, principal)
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_app_grants_app_idx ON vendo_app_grants (app_id)",
  // The other leg of §9.2's two queries: `apps.list` asks "which apps does THIS
  // principal reach?" once per encoding the caller satisfies (user, each org,
  // each team). Without this index every one of those is a seq scan of the whole
  // grant table on the hot list path — the same order-of-magnitude regression
  // the perf gate exists to catch.
  "CREATE INDEX IF NOT EXISTS vendo_app_grants_principal_idx ON vendo_app_grants (principal)",
] as const;

// Additive columns stay compatible with same-version development databases (02 §2
// allows additive columns within the version train; key columns are untouched).
// vendo_state gains a stable record id (generated from the app_id:subject PK, so
// point lookups hit an index instead of seq-scanning) and its own created_at, so
// the seam can expose a creation timestamp that survives updates.
const ADDITIVE_DDL = [
  "ALTER TABLE vendo_records ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS session_id text",
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz",
  // Risk-grading redesign: a standing denial must know WHO said no, must be
  // takeable-back, and must be findable by call id without scanning a
  // subject's whole approval history.
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS denied_by text",
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS voided_at timestamptz",
  "ALTER TABLE vendo_approvals ADD COLUMN IF NOT EXISTS call_id text",
  "CREATE INDEX IF NOT EXISTS vendo_approvals_subject_status_call_idx ON vendo_approvals (subject, status, call_id)",
  "ALTER TABLE vendo_state ADD COLUMN IF NOT EXISTS id text GENERATED ALWAYS AS (app_id || ':' || subject) STORED",
  // created_at is the pagination cursor column, so it must never be NULL. DEFAULT now()
  // fills the column for any direct INSERT that omits it (the table map is public); our
  // own write paths always populate it explicitly.
  "ALTER TABLE vendo_state ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()",
  // ADD COLUMN IF NOT EXISTS SKIPS when the column already exists, so databases that
  // booted before the DEFAULT was introduced would keep a default-less column forever.
  // SET DEFAULT is idempotent, so it runs every boot like the rest of this block.
  "ALTER TABLE vendo_state ALTER COLUMN created_at SET DEFAULT now()",
  "CREATE INDEX IF NOT EXISTS vendo_state_id_idx ON vendo_state (id)",
  // Keyset pagination lists order by (created_at, id) DESC — compared at millisecond
  // precision via date_trunc (helpers/utils.ts cursorMs; cursors round-trip through JS
  // Dates) — with a matching `<` tuple predicate (records.ts / routing.ts). These btree
  // indexes serve the equality/filter legs (the truncated sort itself is a top-N over the
  // filtered set); a dropped index here is exactly the order-of-magnitude regression the
  // perf gate exists to catch.
  "CREATE INDEX IF NOT EXISTS vendo_records_collection_created_idx ON vendo_records (collection, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_mcp_clients_created_idx ON vendo_mcp_clients (created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_mcp_grants_created_idx ON vendo_mcp_grants (created_at DESC, id DESC)",
  // The knowledge collections list newest-first for the corpus read-back
  // (status()/listing, F2's 1000-row page bound), same keyset shape as the door
  // tables above.
  "CREATE INDEX IF NOT EXISTS vendo_knowledge_docs_created_idx ON vendo_knowledge_docs (created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_knowledge_chunks_created_idx ON vendo_knowledge_chunks (created_at DESC, id DESC)",
  // The automations tick and vendo.emit fetch apps by trigger kind (schedule / host-event).
  // A STORED generated column projects the kind into an indexable value so those paths query
  // only the matching apps instead of scanning every app for every subject.
  // ADD COLUMN ... GENERATED ALWAYS AS ... STORED backfills existing rows on ALTER, so no
  // separate data migration is needed (mirrors the vendo_state.id generated column above).
  //
  // ONE COLUMN PER KIND, because an app has a LIST of triggers: "which kind does this app
  // fire on" is a set, and a ref is matched by equality. The single `trigger_kind` column
  // this replaces could only hold one, so an app with a schedule AND a host-event trigger
  // would have gone dark on one of them. Each column reads BOTH document shapes — the
  // `triggers` list and the pre-list `trigger` object — because the generated column sees
  // the doc exactly as stored, and read-time normalization happens above the store: a
  // legacy row that nobody has re-armed yet must still be found by the tick.
  ...(["schedule", "host-event", "external"] as const).flatMap((kind) => [
    `ALTER TABLE vendo_apps ADD COLUMN IF NOT EXISTS trigger_kind_${kind.replace(/-/g, "_")} text `
    + `GENERATED ALWAYS AS (CASE WHEN doc->'triggers' @> '[{"on":{"kind":"${kind}"}}]'::jsonb `
    + `OR doc->'trigger'->'on'->>'kind' = '${kind}' THEN '1' END) STORED`,
  ]),
  // Indexed where a ref-filtered query actually exists: the tick asks for schedule apps
  // deployment-wide, `emit` asks for one subject's host-event apps. External triggers arrive
  // through `webhook`, which verifies a signature per row and still scans; it gets a column
  // for symmetry (so the ref key exists the day it stops scanning) and no index it never uses.
  // An automation grant is consented to per (app, TRIGGER): the engine refuses a grant whose
  // trigger id is not the one firing, so this column is authority, not metadata. NULL on every
  // grant that is not an automation's, and on automation grants minted before an app had a
  // trigger list — the engine reads a missing value as the `main` those documents normalize to.
  "ALTER TABLE vendo_grants ADD COLUMN IF NOT EXISTS trigger_id text",
  "DROP INDEX IF EXISTS vendo_apps_subject_trigger_idx",
  "ALTER TABLE vendo_apps DROP COLUMN IF EXISTS trigger_kind",
  "CREATE INDEX IF NOT EXISTS vendo_apps_trigger_schedule_idx ON vendo_apps (trigger_kind_schedule)",
  "CREATE INDEX IF NOT EXISTS vendo_apps_subject_trigger_host_event_idx ON vendo_apps (subject, trigger_kind_host_event)",
  // Thread listing derives a title without loading the full messages array (routing.ts uses a
  // messages-less listSelect once a row has a stored title). NULLable; populated on next write.
  "ALTER TABLE vendo_threads ADD COLUMN IF NOT EXISTS title text",
  // ENG-310: revision counter backing the routed vendo_threads atomic capability
  // (01 §12 — insertIfAbsent / compareAndSwap), so concurrent turns on one thread
  // can do guarded read-merge-write instead of last-write-wins. DEFAULT backfills
  // existing rows on ALTER; every write path bumps it.
  "ALTER TABLE vendo_threads ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
  // Wave 7: the same counter for vendo_apps, so the machine lifecycle and the
  // schedule engine's fire claims (updateAppRow's read-mutate-CAS) stop
  // degrading to read-then-put on the dev store — a multi-process dev host
  // could double-fire a schedule or clobber a concurrent lifecycle write.
  "ALTER TABLE vendo_apps ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
  // Tracks the secret's last rewrite (rotation) separately from created_at;
  // set() stamps it. NULL on legacy rows means created_at IS the last write.
  "ALTER TABLE vendo_secrets ADD COLUMN IF NOT EXISTS updated_at timestamptz",
  // The TTL sweep's stale scan and the host-driven claim both predicate on
  // touched_at (sessions.ts); without this a busy anonymous host seq-scans
  // the registry on every sweep interval.
  "CREATE INDEX IF NOT EXISTS vendo_sessions_touched_idx ON vendo_sessions (touched_at)",
  // vendo_effects.subject arrived after the table did, both inside the
  // unreleased v6 train — so a development database created earlier in this
  // wave already has the table WITHOUT the column, and the version gate above
  // will never re-run its CREATE. The DEFAULT is what makes NOT NULL addable to
  // those pre-amendment rows; it is deliberately an empty subject, since a
  // receipt written before the column existed genuinely has no known owner, and
  // every write path has supplied one since.
  "ALTER TABLE vendo_effects ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT ''",
] as const;

// v2 backfill (runs once, only when upgrading from a version < 2 — 02 §4 keys
// migrations by vendo_meta.schema_version, forward-only). Three moves:
//   1. Relocate legacy vendo_state singletons that a pre-fix deployment wrote into
//      vendo_records (collection 'vendo_state', id `${app_id}:${subject}`) into the
//      dedicated table. App ids are colon-free and non-empty (`^app_[^:]+$`), so the
//      FIRST colon splits id into app_id + subject unambiguously; the
//      `id ~ '^app_[^:]+:.'` predicate relocates only rows whose leading segment is a
//      real app id AND whose subject is non-empty — the SAME shape the state door
//      (splitStateId) enforces. Anything else (colon-less rows, ids whose first
//      segment is not app-shaped, or empty-subject ids like 'app_x:') SURVIVES in
//      vendo_records rather than being silently destroyed or misrouted.
//   2. The DELETE is scoped to the identical predicate as the INSERT — only the rows
//      actually relocated are removed.
//   3. Both write doors were live pre-fix (stateStore wrote the dedicated table, the
//      seam wrote vendo_records), so a legacy row can be NEWER than an existing
//      dedicated row. Resolve by timestamp (`WHERE vendo_state.updated_at <
//      EXCLUDED.updated_at`) so the newer write wins instead of DO NOTHING dropping it.
//   4. Relocated rows set created_at = updated_at on insert (the column now DEFAULTs to
//      now(), so it must be given the legacy timestamp explicitly); the trailing UPDATE
//      still backfills created_at for any pre-existing row that predates the column.
const DATA_BACKFILL = [
  `INSERT INTO vendo_state (app_id, subject, data, updated_at, created_at)
   SELECT split_part(id, ':', 1), substring(id FROM position(':' IN id) + 1), data, updated_at, updated_at
   FROM vendo_records WHERE collection = 'vendo_state' AND id ~ '^app_[^:]+:.'
   ON CONFLICT (app_id, subject) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
     WHERE vendo_state.updated_at < EXCLUDED.updated_at`,
  "DELETE FROM vendo_records WHERE collection = 'vendo_state' AND id ~ '^app_[^:]+:.'",
  "UPDATE vendo_state SET created_at = updated_at WHERE created_at IS NULL",
] as const;

// v6 backfill (build contract §6): split every existing vendo_threads.messages
// array into one vendo_thread_messages row, then drop the column.
//
// Guarded on the COLUMN's existence, not just the version, because the two must
// agree: a fresh database is created by the v6 DDL above and never had
// `messages`, so a version gate alone would run this SQL against a column that
// does not exist. The information_schema check makes the whole step idempotent
// and safe to re-apply.
//
// `seq` comes from WITH ORDINALITY (1-based) shifted to 0-based, so the stored
// array order — the only order a legacy row carries — becomes the ordering
// authority.
//
// It never loses a message, and that takes real work rather than a comment. Two
// ways a candidate id collides, both found in the wild by the verifier:
//   1. a legacy array simply repeats an `id` (the client minted it, so nothing
//      ever enforced uniqueness inside the array);
//   2. a message with NO id derives `msg_<index>`, which can equal a real
//      message's literal id (`msg_0`).
// `ON CONFLICT DO NOTHING` silently dropped the loser in both cases. Instead a
// window function numbers the candidates per (thread, id) in array order and
// suffixes every duplicate after the first with its index — deterministic, so a
// re-run produces the same ids, and lossless, so nobody's words disappear.
const DATA_BACKFILL_V6 = [
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'vendo_threads' AND column_name = 'messages'
     ) THEN
       INSERT INTO vendo_thread_messages (thread_id, id, seq, message, created_at, updated_at)
       SELECT thread_id,
              CASE WHEN dup = 1 THEN candidate_id
                   ELSE candidate_id || '#' || seq::text END,
              seq, message, created_at, updated_at
       FROM (
         SELECT t.id AS thread_id,
                COALESCE(a.elem->>'id', 'msg_' || (a.ordinality - 1)::text) AS candidate_id,
                (a.ordinality - 1)::integer AS seq,
                a.elem AS message,
                t.created_at, t.updated_at,
                ROW_NUMBER() OVER (
                  PARTITION BY t.id, COALESCE(a.elem->>'id', 'msg_' || (a.ordinality - 1)::text)
                  ORDER BY a.ordinality
                ) AS dup
         FROM vendo_threads t
         CROSS JOIN LATERAL jsonb_array_elements(t.messages) WITH ORDINALITY AS a(elem, ordinality)
         WHERE jsonb_typeof(t.messages) = 'array'
       ) numbered
       ON CONFLICT (thread_id, id) DO NOTHING;

       ALTER TABLE vendo_threads DROP COLUMN messages;
     END IF;
   END
   $$`,
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
  // runs ONLY while upgrading past ITS version (< 2) — never unconditionally, or a
  // newer vendo_records write in a mixed-version deploy would be repeatedly
  // relocated/lost, and never on later bumps (v2→v3 adds tables only).
  if (version === undefined || version < 2) {
    for (const statement of DATA_BACKFILL) await query(statement);
  }
  // The v6 split is guarded on the column itself (see DATA_BACKFILL_V6), so it
  // is safe on every boot — including a fresh database, where it does nothing.
  for (const statement of DATA_BACKFILL_V6) await query(statement);
  await query(
    `INSERT INTO vendo_meta (key, value) VALUES ('boot_id', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(globalThis.crypto.randomUUID())],
  );
}

/** 02-store §4 */
export async function ensureSchema(db: Db): Promise<void> {
  await db.withSchemaLock(migrate);
}
