# Automations OSS Release Readiness — Durable Persistence, Scheduler Liveness, Composio Ingress

**Date:** 2026-07-04 (v2 — amended after Codex adversarial review, 21 findings triaged)
**Status:** Design approved by Yousef (brainstorm session); ready for planning
**Owner:** automations-oss-brainstorm session

## Problem

The automations engine ships and is self-hostable, but every persistence surface in the
embedded (`@flowlet/next`) world is in-memory: automations, versions, grants, run history,
approval decisions, chat threads, and saved flowlets all vanish on server restart. Schedules
only fire while a client pings `POST /tick`, so "runs when you're not in the app" is not true
in OSS today. Composio triggers have no OSS ingress path. This design makes the automations
pillar release-ready.

## Decisions (locked with Yousef)

1. **Primary persona:** the self-hoster on a long-lived Node process (Docker/VPS/`next start`),
   with hosted-Postgres users (Supabase et al.) first-class and serverless supported via
   documented external cron.
2. **One datastore for the release surfaces:** a single database holds automations,
   decisions, threads, saved flowlets, and Composio connections. (Audit events are a named
   follow-up, not in this release — see Out of scope.)
3. **Postgres dialect only, via Drizzle ORM.** No SQLite dialect. Zero-infra installs use
   **PGlite** (embedded Postgres, file-backed) as the default; any real Postgres via
   `DATABASE_URL`. Drizzle chosen over Kysely because the single-dialect decision removes
   Kysely's portability advantage while Drizzle keeps popularity, familiarity, schema DSL,
   and migration tooling.
4. **Day-1 scope: all four surfaces** — automations engine store, approval decisions,
   chat threads, saved flowlets.
5. **Scheduler:** internal croner timer on long-lived Node (via a real boot hook, see §3)
   *and* `POST /tick` with service auth for external drivers; boot-time rehydration of
   schedules from the durable store.
6. **Composio triggers get an OSS path:** a signature-verified webhook ingress route in
   `@flowlet/next`, single-tenant in v1. No polling fallback.
7. **PR #34 (remix + toasts) and PR #35 (source-baseline) both fold into this release**
   as separate PRs on the release train (Yousef ruling; Codex flagged the scope risk and
   it is accepted).
8. **Concurrency posture (v1): single-writer.** One process owns the scheduler and runner.
   The store is transactionally safe where cheap (dedup PK, atomic counters, atomic approval
   claim), and full multi-replica coordination (leases/advisory locks per automation) is a
   named non-goal. Documented in the deploy guide.
9. **Acceptance bar:** the kill-the-server drill (below), run on PGlite and on Supabase,
   plus one live Composio webhook firing on a deployed host.

## Design

### 1. Storage foundation — new package `@flowlet/store`

- Owns the Drizzle Postgres schema, generated migration SQL, and durable implementations of
  the persistence seams. `@flowlet/runtime` stays dependency-free (dependency-guard
  allowlist untouched); interfaces stay where they are (`@flowlet/core` / runtime), the new
  package only implements them.
- **Adopter surface — one knob on `createFlowletHandler`:**
  - nothing configured → PGlite at `.flowlet/data/` (overridable via `FLOWLET_DATA_DIR`),
    created on first boot — the dev/VPS default;
  - `DATABASE_URL` (or explicit `storage:` option) → any real Postgres: Supabase, Neon, RDS,
    Docker;
  - explicit in-memory remains for tests, with a boot warning if it is ever the production
    fallback.
- **PGlite guardrails (Codex blocker):** PGlite is single-process by design. The store holds
  a process-wide singleton (`globalThis`-keyed, HMR-safe); boot fails loudly if the data dir
  is not writable; on known-serverless environments (`VERCEL`, Cloudflare, etc.) defaulting
  to PGlite is an explicit boot **error** naming `DATABASE_URL` as the fix — never a silent
  ephemeral store.
- **Migrations (Codex blocker):** drizzle-kit generates SQL at our dev time; files ship in
  the package; applied programmatically on first connection behind (a) a per-process init
  promise and (b) a Postgres advisory lock, so concurrent cold starts can't race DDL.
  Privilege preflight: a clear error when the role can't create schema/tables (managed-PG
  restricted roles). `autoMigrate: false` + an exported migration entry point for shops that
  gate DDL; applied migrations tracked in Drizzle's migrations table.
- **Namespacing:** all Flowlet tables live in a dedicated `flowlet` Postgres schema, keeping
  the adopter's `public` schema pristine (PGlite supports schemas).
- **Tables (8):** automations, automation_versions, automation_runs, decisions, threads,
  thread_messages, saved_flowlets, connections (Composio connected-account ↔ principal).
  JSON-heavy columns are `jsonb`. Every table keeps the `tenant_id` / `subject` columns the
  seams already carry, so the same schema serves the multi-tenant cloud later. The embedded
  world remains single-tenant (see §6).

### 2. The four surfaces

- **Automations engine store:** `DrizzleAutomationStore` implements the existing
  `AutomationEngineStore` seam, behavior-identical to `InMemoryAutomationStore` (which is
  the semantic spec): same version rows, refined outcomes, truncation caps. Deltas beyond
  a straight port, all from review:
  - `firingRunId` is the runs primary key — duplicate firings fail at the DB layer;
  - counters update inside the finalize transaction (no read-modify-write races);
  - **approval resume is an atomic claim** — a single conditional UPDATE clears
    `pendingApproval` and marks the run resuming; approve/decline is idempotent and a second
    caller gets a clean "already decided" error;
  - **checkpoints are versioned:** the interpreter checkpoint (already JSON-shaped) gains a
    schema-version field, validated on resume; a mismatch fails the run with a clear error,
    never a silent misresume;
  - a cross-scope `listEnabledSchedules()` method (id, trigger, stored principal) exists
    solely for boot rehydration — the frozen per-scope surface is unchanged.
- **Decisions:** the existing `DecisionStore` contract (canonical policy key → decision)
  gets a durable table keyed by principal + canonical key. It stays **separate** from
  automation grants (version metadata inside automation_versions) and from the future
  ENG-193 GrantStore — same database, distinct contracts (Codex: don't conflate).
- **Threads (amended per review — the `/chat` contract makes naive append wrong):**
  server-owned `threadId`; incoming client messages are **upserted by message id** (the ai
  SDK mutates message parts on approval/resume, so parts are replaced wholesale, honoring
  the ENG-204 `originalMessages` gotcha); the assistant message is persisted once on stream
  settlement (`onFinish`). Ordering is a per-thread monotonic `seq` allocated
  transactionally with `unique(thread_id, seq)` — never `created_at`. Reads return
  seq-ordered messages.
- **Saved flowlets (amended per review — a server store alone changes nothing):** the shell
  already talks to a `Store` seam, currently wired to localStorage in `FlowletRoot`. This
  release adds `/flowlets` handler endpoints backed by a durable registry table (keeping
  ENG-186 versioning/drift-notice semantics) **plus** a server-backed client `Store` adapter
  that `FlowletRoot` wires automatically when the handler has durable storage. Shape
  reconciliation (ids/timestamps) is part of the work; 60s live-refresh and FIFO undo stay
  client-side.

### 3. Scheduler liveness

- **Boot hook (Codex blocker — route handlers assemble lazily):** the codemod and quickstart
  add a Next `instrumentation.ts` that calls a new `startFlowletScheduler()` entry point at
  server boot — the real Next boot hook, no request needed. The handler *also* ensures
  world-init on first request (belt and braces). A `globalThis` singleton guards against
  dev-HMR and multi-worker double-timers. `FLOWLET_SCHEDULER=external` disables the internal
  timer entirely.
- **Boot rehydration:** world assembly loads every enabled schedule-triggered automation via
  `listEnabledSchedules()` and registers each with its stored principal before serving
  traffic. The frozen `Scheduler` seam is unchanged.
- **Two clock drivers, same pipeline:**
  - long-lived Node: internal croner interval (unref'd), zero setup;
  - serverless/external: `POST /tick` authenticated by **`FLOWLET_TICK_SECRET` (service
    auth, independent of the user-principal guard — Codex: the current guard 403s real
    cron)**; docs ship copy-paste Vercel cron and Cloudflare Cron Trigger config. Without
    the secret set, remote ticks are refused (client-driven ticks from an authenticated
    session still work as today).
- **Missed-fire policy unchanged and now explicit:** the due-window starts at process boot
  (`lastTickMs` is never persisted) — skipped fires stay skipped after downtime, no backfill.
  The stored "last ticked at" heartbeat is **observability only** and never feeds window
  math (Codex: don't let the heartbeat resurrect missed fires).
- **One-shot `at` schedules:** after firing, the engine pauses the automation
  (`disabledReason: completed_one_shot`) so rehydration can't resurrect a spent one-shot and
  the UI shows an honest state.
- **Double-fire safety:** DB dedup on `firingRunId` makes timer+cron overlap or a restart
  mid-window a duplicate-key no-op. (Full multi-replica coordination: out of scope, §Decisions 8.)
- **Observability:** heartbeat timestamp stored on tick; the "scheduler last ticked at …"
  UI indicator is **data-plumbed but not built** — UI ships only after Yousef reviews it.

### 4. Composio webhook ingress

- **Routing fix first:** the handler's `subPath()` matches only the last path segment; it
  is extended to match the full catch-all tail (existing single-segment routes unchanged),
  reserving `webhooks/composio`.
- **Verification (pinned, per review):** HMAC over the **raw request body** using Composio's
  signing contract (signature + timestamp headers), constant-time compare, ±5 min timestamp
  tolerance. Missing secret env → route responds 404 and boot logs a warning (fail closed).
  Bad signature → 401. Malformed payload → 400, logged, never fired. Verified-but-no-match
  → 200 (don't trigger Composio retries).
- **Principal resolution (Codex blocker):** v1 is explicitly **single-tenant** — matching
  the embedded world. The `connections` table records the Composio connected-account id when
  an integration is connected; an incoming event fires only if its connected-account id maps
  to a known connection, and it fires under that connection's stored principal (today: the
  world's fixed scope). Unknown account → 200 + logged skip. This is also the seam
  multi-tenant cloud routing plugs into later.
- **Dedup:** Composio's delivery id becomes `TriggerEnvelope.eventId` → redelivery is a
  duplicate-run no-op. Fan-out uses `findEnabledByTrigger` and the same firing pipeline as
  host events.
- **Unattended-tool honesty (review):** client-executed host tools (`.flowlet/tools.json`)
  cannot run with no browser attached; automations may only reference server-registered
  tools. Already enforced by the authoring world; this release adds an explicit
  compile/authoring-time rejection with a clear message and documents it.
- Local dev: documented tunnel or `run_now`. The stale "cloud-only" comment in
  `in-process-scheduler.ts` is corrected.

### 5. PR #34 / #35

- **PR #34** (remix + toasts; built, browser-verified, triple-reviewed) goes through
  Yousef's review/merge first; persistence work rebases onto it.
- **PR #35** (source-baseline follow-up) is built from its existing spec+plan as part of
  this release, as its own PR. Standing UI gate applies to both.

### 6. Single-tenant posture (explicit)

The embedded world keeps one fixed principal (`world.ts` contract). Durable storage does not
change that: if a host configures a `principal` resolver for endpoint gating, all callers
still share one store. This is documented in the deploy guide, and the handler logs a
one-time warning when a custom principal resolver is combined with durable storage (the
cross-user-leakage trap Codex named). Every table already carries `tenant_id`/`subject`, so
per-user partitioning is a cloud-phase behavior change, not a schema migration.

## Error handling

- Storage misconfiguration (bad `DATABASE_URL`, unwritable PGlite dir, failed migration,
  missing DDL privileges) fails handler boot loudly — never a silent in-memory fallback in
  production.
- Webhook ingress: fail-closed on missing secret; response-code contract above.
- Checkpoint version mismatch on resume → run fails with a clear error.
- In-memory fallback in production logs a prominent warning.

## Testing

- The existing store/scheduler/runner suites run against `DrizzleAutomationStore` (PGlite in
  CI) in addition to the in-memory store — the seam contract is the shared spec.
- CI job against real Postgres for the migration path (advisory-lock race included: two
  concurrent migrators, one applies).
- Integration tests: scheduler rehydration, double-fire dedup, atomic approval claim
  (concurrent approve+approve → one winner), thread upsert-on-resume (no duplicate or stale
  approval parts), webhook signature accept/reject matrix, one-shot completion.

## Acceptance bar — the kill-the-server drill

Scripted end-to-end, run before release:

1. Fresh `flowlet init` install, zero config → PGlite comes up on first boot
   (instrumentation hook included by the codemod).
2. In chat: author a scheduled automation with a pre-approved grant; save a flowlet; leave a
   thread.
3. Kill and restart the server → automation, grant, thread, saved flowlet all survive.
4. With no tab open, the schedule fires unattended; the run appears in history with the
   grant honored (no re-approval).
5. Repeat with `DATABASE_URL` → real Supabase project.
6. On a deployed host: one live Composio trigger (e.g. Gmail) fires an automation end-to-end
   via the webhook route.

Plus standing bar: tests/typecheck green, docs synced (quickstart + new persistence/deploy
page covering the single-writer posture, serverless cron setup, and tick secret), browser
screenshots for anything UI.

## Out of scope (explicit)

- SQLite/D1/Turso dialects (Postgres-only decision).
- Composio trigger polling for unreachable hosts.
- Multi-tenant embedded world (schema is ready; behavior stays single-tenant).
- Multi-replica scheduler/runner coordination (single-writer v1; dedup PK is the only
  cross-instance guarantee).
- Durable audit-event log (named follow-up; PRD's enterprise audit is a later phase).
- Transient action-approval tokens stay non-durable by design (short-lived by contract).
- Cloud-phase retention/pruning policy (retain-everything ruling stands).
- The "last ticked at" UI element (plumbed, Yousef-gated).
