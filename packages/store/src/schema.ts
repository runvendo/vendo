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

    v4 (kill-list §B3) added `vendo_sessions`, the guest-session registry. Guest
    sessions are gone; the table's CREATE is removed here and ADDITIVE_DDL now
    drops the orphan left behind on databases that already had it.

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
    so this one table is the whole sharing model. Same load-bearing bump.

    v8 adds `vendo_idempotency_ledger` (01 §12 `IdempotencyLedger`): what a keyed
    request already answered, so a replayed `Idempotency-Key` gives that answer
    back instead of applying the mutation a second time. It is a table in THIS
    database rather than a store of its own because the ledger must commit with
    the mutation it gates — one that lives elsewhere can commit while its
    mutation rolls back, and the replay then confidently returns a result for
    work that never happened. Same load-bearing bump.

    v9 adds `vendo_quarantine` (01 §12 `StoreOps.retention`): where a retention
    sweep puts the rows it lifts out of a live collection, so the window between
    `quarantine` and `purge` is recoverable instead of a delete with a nicer
    name. The engine OWNS this table — no caller names it, no collection maps to
    it, and `purge` is the only way back out. It is a table of its own rather
    than a column on every collection because the rows come from thirty-odd
    tables with nothing in common but their id, and a `quarantined_at` column
    apiece would mean every read in the store growing a `WHERE quarantined_at IS
    NULL` it can never be trusted to remember. Same load-bearing bump.

    v10 adds `vendo_usage` (01 §12 `StoreOps.usage`): the meter a host's
    `LimitsCallback` decides on. One row per metered action, keeping its own
    instant — never a pre-bucketed count, because a policy authors its own
    window ("20 messages an hour", "3 generations today") and a bucket can only
    answer the periods whoever chose it happened to pick. It is engine-owned
    like `vendo_quarantine`: no collection maps to it and no door lists it, so a
    meter row is only ever counted. Same load-bearing bump.

    v11 makes the AUTOMATION the first-class record and takes the app's place in
    the two tables that assumed one. `vendo_automations` is the new drawer: one
    principal-owned record per row, `subject` (the owner) the erase-cascade
    selector — a row carries a live webhook signing key, so a record that
    outlived its owner's erasure would be a hole, not an untidiness — and
    `revision` the optimistic-concurrency counter the row's atomic verbs turn.
    No caller claims a fire through it: the tick arbitrates on the schedule
    cursor instead (packages/automations/src/ingestion-surface.ts).
    `vendo_runs` re-keys `app_id`
    to `automation_id`, because a run belongs to the record that fired it and an
    automation holds no app reference at all; `vendo_grants` re-keys `trigger_id`
    to `automation_id` for the same reason — the trigger it named lived inside an
    app document that no longer has triggers. Stored run rows are DROPPED rather
    than migrated: an app-keyed run cannot be read by the new path and no
    selector reaches it, so ADDITIVE_DDL empties the table ONCE, guarded on the
    old column's existence. Same load-bearing bump as v5 — the DDL loop only runs
    while version < SCHEMA_VERSION, so without it no existing database would ever
    create the new table.

    v12 moves harness continuity onto the thread row and DELETES `vendo_state`.
    The bookmark a session-owning harness resumes on (its native-session ref) rode
    `vendo_state` under a synthetic `app_id` of `harness_state:<threadId>`, which
    bought "no new table" at the price of a slot that no table cascade covered:
    thread deletion swept it by hand in two places (ops.ts, helpers/threads.ts), a
    retention sweep needed a fence to keep the app-state door from seeing it, and
    the erase cascade reached it only through a second selector. It is one
    nullable `harness_state jsonb` column on `vendo_threads` now — ONE slot per
    thread, on the row that already carries the thread's owner — so every one of
    those hand-wired cascades is simply the row going away.

    `vendo_state`'s OTHER tenant, an app's per-user state, is dropped rather than
    migrated: nothing has written it since the appData family took over, so the
    table's only live rows were the harness slots the backfill below relocates.
    The v2 backfill goes with it — it relocated legacy rows INTO this table, and
    there is no longer anywhere to put them. Any legacy `vendo_records` row under
    collection `vendo_state` simply stays where it is, unread, rather than being
    moved into a table that is about to be dropped. */
export const SCHEMA_VERSION = 12;

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
  // v6 (build contract §6): the thread row is metadata only — `messages` moved
  // to vendo_thread_messages, one row per message.
  // v12: `harness_state` is the conversation's harness continuity — the opaque
  // native-session ref a session-OWNING harness resumes on. NULLable, because
  // most threads never have one; ONE slot per thread, because a conversation has
  // one thinker at a time (a foreign harness DESTROYS the slot rather than
  // shadowing it). It is a column rather than a table so that deleting the
  // thread deletes the bookmark — the row IS the cascade.
  `CREATE TABLE IF NOT EXISTS vendo_threads (
    id text PRIMARY KEY, subject text NOT NULL,
    harness_state jsonb,
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
  // v11: the automation record, owned by a PRINCIPAL and naming no app. `data`
  // is the whole record (core's `automationRecordSchema`); `subject` and `armed`
  // are projections of it, the first because the erase cascade selects on it and
  // a stored webhook secret must never outlive its owner. `revision` is the CAS
  // counter the fire claim turns, so two ticks cannot both claim one record.
  //
  // `when_kind` is the indexable projection the two hot paths read: the tick asks
  // for every schedule record deployment-wide, `emit` for one subject's
  // host-event records, and without a column both are a scan of every automation
  // on every tick. ONE column, where `vendo_apps` needed one per kind: a record
  // has exactly one trigger, so the kind is a value rather than a set.
  `CREATE TABLE IF NOT EXISTS vendo_automations (
    id text PRIMARY KEY, subject text NOT NULL, armed boolean NOT NULL DEFAULT true,
    data jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    when_kind text GENERATED ALWAYS AS (data->'when'->>'kind') STORED
  )`,
  "CREATE INDEX IF NOT EXISTS vendo_automations_subject_idx ON vendo_automations (subject)",
  "CREATE INDEX IF NOT EXISTS vendo_automations_when_kind_idx ON vendo_automations (when_kind)",
  "CREATE INDEX IF NOT EXISTS vendo_automations_subject_when_kind_idx ON vendo_automations (subject, when_kind)",
  `CREATE TABLE IF NOT EXISTS vendo_runs (
    id text PRIMARY KEY, automation_id text NOT NULL, trigger jsonb NOT NULL, status text NOT NULL,
    record jsonb NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz
  )`,
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
  // v8 (01 §12): the `Idempotency-Key` replay ledger, in the shape the Vendo
  // Cloud console already runs. `status` + `result` are the answer a repeat
  // caller is handed back verbatim; `request_hash` is what separates a replay
  // from the same key carrying a DIFFERENT body, which is a client bug and not a
  // replay at all. The PK is the whole scope, `tenant` first, so a mount serving
  // many tenants out of one schema cannot let one tenant's key answer another's.
  `CREATE TABLE IF NOT EXISTS vendo_idempotency_ledger (
    tenant text NOT NULL, op text NOT NULL, key text NOT NULL,
    request_hash text NOT NULL, status int NOT NULL, result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant, op, key)
  )`,
  // v9 (01 §12 `StoreOps.retention`): the engine's quarantine. One row per
  // record a sweep lifted, holding the live row VERBATIM (`to_jsonb` of the
  // whole row, whichever table it came from) so nothing about it is lost while
  // it waits out the recovery grace. `collection` is the drawer it left,
  // `quarantined_at` is what `purge` measures its grace from — never the row's
  // own age, which is already past.
  // `subject`/`app_id` are lifted out of the row on the way in, because a
  // quarantined row is still that person's data: without those two columns no
  // erase selector could reach it and a sweep would be a way to survive an
  // erasure (`vendo_effects`' frozen v1 shape is the same lesson).
  // The key carries `quarantined_at` so a row re-created after a sweep and swept
  // again is a second quarantined copy, not an overwrite of the first — the
  // first is still inside its own grace.
  `CREATE TABLE IF NOT EXISTS vendo_quarantine (
    collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
    subject text, app_id text,
    quarantined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection, id, quarantined_at)
  )`,
  // purge's own statement: one collection, everything lifted before a cutoff.
  // The primary key leads with (collection, id), so it cannot serve that range.
  "CREATE INDEX IF NOT EXISTS vendo_quarantine_collection_at_idx ON vendo_quarantine (collection, quarantined_at)",
  // The erase cascade's two selectors (§5).
  "CREATE INDEX IF NOT EXISTS vendo_quarantine_subject_idx ON vendo_quarantine (subject)",
  "CREATE INDEX IF NOT EXISTS vendo_quarantine_app_idx ON vendo_quarantine (app_id)",
  // v10 (01 §12 `StoreOps.usage`): the meter. One row per metered action, and
  // `pool_keys` is the shared buckets that action ALSO drew down, copied off
  // the user at write time — a member who leaves a team must not retroactively
  // drain its quota, and the row is the only place that membership was true.
  `CREATE TABLE IF NOT EXISTS vendo_usage (
    id text PRIMARY KEY, subject text NOT NULL, action text NOT NULL,
    at timestamptz NOT NULL, pool_keys text[]
  )`,
  // The count's two shapes, one index each: a person's window is an equality on
  // (subject, action) with a range on `at`, and a pool's is a containment test
  // the btree cannot serve at all.
  "CREATE INDEX IF NOT EXISTS vendo_usage_subject_action_at_idx ON vendo_usage (subject, action, at)",
  "CREATE INDEX IF NOT EXISTS vendo_usage_pool_keys_idx ON vendo_usage USING GIN (pool_keys)",
] as const;

// Additive columns stay compatible with same-version development databases (02 §2
// allows additive columns within the version train; key columns are untouched).
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
  // v11: an app document no longer HAS triggers, so every projection of one off
  // `vendo_apps` goes — the single pre-list `trigger_kind` column and the later
  // per-kind generated columns alike. Dropped by pattern rather than by name so
  // the names leave the codebase entirely; dropping a column takes its indexes
  // with it, so there is nothing else to clean up. Same law as the
  // `vendo_sessions` drop below: the version gate would never re-run the DDL
  // loop on a database that already carries them, so this runs every boot.
  `DO $$
   DECLARE projection text;
   BEGIN
     FOR projection IN
       SELECT column_name FROM information_schema.columns
       WHERE table_name = 'vendo_apps' AND column_name LIKE 'trigger\\_kind%'
     LOOP
       EXECUTE format('ALTER TABLE vendo_apps DROP COLUMN %I', projection);
     END LOOP;
   END
   $$`,
  "DROP INDEX IF EXISTS vendo_apps_subject_trigger_idx",
  // A grant is consented to per AUTOMATION now, and the engine refuses a grant
  // whose automation is not the one firing — so this column is authority, not
  // metadata. It replaces `trigger_id`, which named a trigger inside an app
  // document; there is no such thing to name any more, so the old column is
  // dropped rather than read as a fallback. NULL on every grant that is not an
  // automation's. Indexed with `subject`, which is how the engine asks: one
  // owner's standing grants for one record, at fire time.
  "ALTER TABLE vendo_grants ADD COLUMN IF NOT EXISTS automation_id text",
  "ALTER TABLE vendo_grants DROP COLUMN IF EXISTS trigger_id",
  "CREATE INDEX IF NOT EXISTS vendo_grants_subject_automation_idx ON vendo_grants (subject, automation_id)",
  // v11: a run belongs to an AUTOMATION. Existing rows are keyed by an app, and
  // nothing reads them that way any more — no read path, no erase selector — so
  // they are destroyed rather than left as unreachable user data. Guarded on the
  // old column, so it happens once and leaves a re-keyed table empty enough to
  // take the NOT NULL below.
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'vendo_runs' AND column_name = 'app_id'
     ) THEN
       DELETE FROM vendo_runs;
       ALTER TABLE vendo_runs DROP COLUMN app_id;
     END IF;
   END
   $$`,
  "DROP INDEX IF EXISTS vendo_runs_app_started_idx",
  "ALTER TABLE vendo_runs ADD COLUMN IF NOT EXISTS automation_id text NOT NULL",
  "CREATE INDEX IF NOT EXISTS vendo_runs_automation_started_idx ON vendo_runs (automation_id, started_at)",
  // Thread listing derives a title without loading the full messages array (routing.ts uses a
  // messages-less listSelect once a row has a stored title). NULLable; populated on next write.
  "ALTER TABLE vendo_threads ADD COLUMN IF NOT EXISTS title text",
  // ENG-310: revision counter backing the routed vendo_threads atomic capability
  // (01 §12 — insertIfAbsent / compareAndSwap), so concurrent turns on one thread
  // can do guarded read-merge-write instead of last-write-wins. DEFAULT backfills
  // existing rows on ALTER; every write path bumps it.
  "ALTER TABLE vendo_threads ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
  // v12: harness continuity's new home. Additive AND in the CREATE above, like
  // every other column here, so a database already at v12 and one created fresh
  // reach the same shape.
  "ALTER TABLE vendo_threads ADD COLUMN IF NOT EXISTS harness_state jsonb",
  // Wave 7: the same counter for vendo_apps, so the machine lifecycle and the
  // schedule engine's fire claims (updateAppRow's read-mutate-CAS) stop
  // degrading to read-then-put on the dev store — a multi-process dev host
  // could double-fire a schedule or clobber a concurrent lifecycle write.
  "ALTER TABLE vendo_apps ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
  // Tracks the secret's last rewrite (rotation) separately from created_at;
  // set() stamps it. NULL on legacy rows means created_at IS the last write.
  "ALTER TABLE vendo_secrets ADD COLUMN IF NOT EXISTS updated_at timestamptz",
  // vendo_effects.subject arrived after the table did, both inside the
  // unreleased v6 train — so a development database created earlier in this
  // wave already has the table WITHOUT the column, and the version gate above
  // will never re-run its CREATE. The DEFAULT is what makes NOT NULL addable to
  // those pre-amendment rows; it is deliberately an empty subject, since a
  // receipt written before the column existed genuinely has no known owner, and
  // every write path has supplied one since.
  "ALTER TABLE vendo_effects ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT ''",
  // Guest sessions are gone, so the v4 registry is an orphan on any database that
  // booted before its CREATE was removed. The version gate would never re-run the
  // DDL loop on those databases, so the drop lives here and runs every boot.
  "DROP TABLE IF EXISTS vendo_sessions",
  // The routed lists sort by the truncated cursor expression (helpers/utils.ts cursorMs),
  // so a plain (created_at, id) index cannot serve them — the sort key is an expression.
  // These match it exactly, in both the unfiltered and the ref-filtered shape, which turns
  // every hot list from a seq scan + sort into a top-N index scan. They live here rather
  // than in DDL because ADDITIVE_DDL runs on every ensureSchema: behind a version bump
  // they would never reach a database already at the current version.
  "CREATE INDEX IF NOT EXISTS vendo_threads_created_idx    ON vendo_threads    (date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_apps_created_idx       ON vendo_apps       (date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_automations_created_idx ON vendo_automations (date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_runs_started_idx       ON vendo_runs       (date_trunc('milliseconds', started_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_approvals_created_idx  ON vendo_approvals  (date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_grants_granted_idx     ON vendo_grants     (date_trunc('milliseconds', granted_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_app_grants_created_idx ON vendo_app_grants (date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_effects_at_idx         ON vendo_effects    (date_trunc('milliseconds', at, 'UTC') DESC, key DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_threads_subject_created_idx   ON vendo_threads   (subject, date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_runs_status_started_idx       ON vendo_runs      (status,  date_trunc('milliseconds', started_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_approvals_status_created_idx  ON vendo_approvals (status,  date_trunc('milliseconds', created_at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_audit_app_at_idx              ON vendo_audit     (app_id,  date_trunc('milliseconds', at, 'UTC') DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS vendo_grants_app_granted_idx        ON vendo_grants    (app_id,  date_trunc('milliseconds', granted_at, 'UTC') DESC, id DESC)",
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

// v12 backfill: harness continuity moves onto the thread row, then the table it
// rode goes.
//
// Guarded on `vendo_state`'s EXISTENCE rather than on the version, exactly as the
// v6 split is guarded on its column — the two must agree. A fresh database is
// created by the v12 DDL above and never had the table, so a version gate alone
// would run this SQL against a table that does not exist. The information_schema
// check makes the whole step idempotent and safe to re-apply on every boot.
//
// The copy matches on BOTH legs of the old primary key: the synthetic app id
// (`harness_state:<threadId>`, whose suffix is the thread) and the subject, which
// had to equal the thread's own owner for the row to be reachable by the erase
// cascade in the first place. A row whose subject disagrees with its thread's is
// one no read path could ever return — it is left to die with the table rather
// than promoted onto a row it never belonged to.
//
// The table's OTHER tenant — an app's per-user state — is dropped with it. It has
// had no writer since appData took over, so this destroys no live data; and the
// DROP is what makes the whole point of the move true, that there is exactly one
// place a bookmark can live.
const DATA_BACKFILL_V12 = [
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'vendo_state'
     ) THEN
       UPDATE vendo_threads t
          SET harness_state = s.data
         FROM vendo_state s
        WHERE s.app_id = 'harness_state:' || t.id
          AND s.subject = t.subject;

       DROP TABLE vendo_state;
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
  // The v6 split is guarded on the column itself (see DATA_BACKFILL_V6), so it
  // is safe on every boot — including a fresh database, where it does nothing.
  for (const statement of DATA_BACKFILL_V6) await query(statement);
  // Same rule, same reason: guarded on the table it reads, so it is a no-op the
  // moment the move has already happened.
  for (const statement of DATA_BACKFILL_V12) await query(statement);
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
