# Automations OSS Release Readiness — Durable Persistence, Scheduler Liveness, Composio Ingress

**Date:** 2026-07-04
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
2. **One datastore for everything:** a single database holds every Flowlet persistence
   surface, now and in the cloud phase.
3. **Postgres dialect only, via Drizzle ORM.** No SQLite dialect. Zero-infra installs use
   **PGlite** (embedded Postgres, file-backed) as the default; any real Postgres via
   `DATABASE_URL`. Drizzle chosen over Kysely because the single-dialect decision removes
   Kysely's portability advantage while Drizzle keeps popularity, familiarity, schema DSL,
   and migration tooling.
4. **Day-1 scope: all four surfaces** — automations engine store, approval decisions,
   chat threads, saved flowlets.
5. **Scheduler:** internal croner timer auto-starts on long-lived Node *and* `POST /tick`
   remains for external drivers; boot-time rehydration of schedules from the durable store.
6. **Composio triggers get an OSS path:** a signature-verified webhook ingress route in
   `@flowlet/next`. No polling fallback in v1.
7. **PR #34 (remix + toasts) and PR #35 (source-baseline) both fold into this release.**
8. **Acceptance bar:** the kill-the-server drill (below), run on PGlite and on Supabase,
   plus one live Composio webhook firing on a deployed host.

## Design

### 1. Storage foundation — new package `@flowlet/store`

- Owns the Drizzle Postgres schema, generated migration SQL, and durable implementations of
  every persistence seam. `@flowlet/runtime` stays dependency-free (dependency-guard
  allowlist untouched); interfaces stay where they are (`@flowlet/core` / runtime), the new
  package only implements them.
- **Adopter surface — one knob on `createFlowletHandler`:**
  - nothing configured → PGlite at `.flowlet/data/`, created on first boot (dev/VPS default);
  - `DATABASE_URL` (or explicit `storage:` option) → any real Postgres: Supabase, Neon, RDS,
    Docker;
  - explicit in-memory remains for tests, with a boot warning if it is ever the production
    fallback.
- **Migrations run programmatically at handler boot.** drizzle-kit generates SQL at our dev
  time; files ship in the package; `migrate()` applies them on first connection. Adopters
  never run a CLI. Applied migrations tracked in a version table.
- **Namespacing:** all Flowlet tables live in a dedicated `flowlet` Postgres schema, keeping
  the adopter's `public` schema pristine (PGlite supports schemas).
- **Tables (~7):** automations, automation_versions, automation_runs, decisions, threads,
  thread_messages, saved_flowlets. JSON-heavy columns are `jsonb`. Every table keeps the
  `tenant_id` / `subject` columns the seams already carry, so the same schema serves the
  multi-tenant cloud later. The embedded world remains single-tenant.

### 2. The four surfaces

- **Automations engine store:** `DrizzleAutomationStore` implements the existing
  `AutomationEngineStore` seam, behavior-identical to `InMemoryAutomationStore` (which is
  the semantic spec): same version rows, counters, truncation caps, refined outcomes.
  `firingRunId` becomes a primary key, so duplicate firings fail at the DB layer.
  `waiting_approval` runs and their interpreter checkpoints become rows: a run paused for
  approval survives a deploy and resumes on approval.
- **Decisions:** a small table keyed by principal + tool + scope hash behind the
  DecisionStore seam. Built to be the storage for the ENG-193 `GrantStore` contract so the
  permissions build lands on it without churn.
- **Threads:** `threads` + `thread_messages` (ai-SDK message per row, ordered) behind a
  `ThreadStore` seam; chat handler appends/reads instead of holding arrays. Resume honors
  the ENG-204 `originalMessages` gotcha: the store API is append + read-all-ordered, never
  message rewriting.
- **Saved flowlets:** registry rows (with ENG-186 versioning/drift-notice semantics) move
  into the store; 60s live-refresh and FIFO undo stay client-side and unchanged.

### 3. Scheduler liveness

- **Boot rehydration:** with durable storage configured, world assembly loads every enabled
  schedule-triggered automation and registers it with the scheduler before serving traffic.
  The frozen `Scheduler` seam is unchanged.
- **Two clock drivers, same pipeline:**
  - long-lived Node: the handler auto-starts the croner interval (unref'd) on first
    initialization — zero setup, fires with no tab open;
  - serverless/external: `POST /tick` unchanged; quickstart gains copy-paste Vercel cron and
    Cloudflare Cron Trigger config; `FLOWLET_SCHEDULER=external` disables the internal timer.
- **Missed fires:** unchanged policy — skipped, next occurrence wins.
- **Double-fire safety:** DB-level dedup on `firingRunId` makes replicas or timer+cron
  overlap a duplicate-key no-op (safe by construction).
- **Observability:** a "scheduler last ticked at …" indicator in the automations UI (tick
  timestamp stored), so a dead clock is visible in-product. UI goes through Yousef before
  build.

### 4. Composio webhook ingress

- New route action in `@flowlet/next` (e.g. `POST <handler>/webhooks/composio`):
  verify Composio's HMAC signature (secret via env) → map payload to the existing
  `TriggerEnvelope` (Composio delivery id = `eventId`, so redelivery dedups) → look up
  matching automations via `findEnabledByTrigger` → hand off to the same firing pipeline
  host events use.
- Docs: configuring the webhook URL in Composio's dashboard; local dev via tunnel or
  `run_now`. Correct the stale "cloud-only" comment in `in-process-scheduler.ts`.
- No polling fallback in v1.

### 5. PR #34 / #35

- **PR #34** (remix + toasts; built, browser-verified, triple-reviewed) goes through
  Yousef's review/merge first; persistence work rebases onto it.
- **PR #35** (source-baseline follow-up) is built from its existing spec+plan as part of
  this release. Standing UI gate applies to both.

## Error handling

- Storage misconfiguration (bad `DATABASE_URL`, failed migration) fails the handler boot
  loudly — never silently falls back to in-memory in production.
- Webhook ingress rejects unverifiable signatures; malformed payloads are logged and dropped
  without firing.
- In-memory fallback in production logs a prominent warning.

## Testing

- The existing store/scheduler/runner test suites run against `DrizzleAutomationStore`
  (PGlite in CI) in addition to the in-memory store — the seam contract is the shared spec.
- CI job against real Postgres for the migration path.
- Scheduler rehydration + double-fire dedup covered by integration tests.

## Acceptance bar — the kill-the-server drill

Scripted end-to-end, run before release:

1. Fresh `flowlet init` install, zero config → PGlite comes up on first boot.
2. In chat: author a scheduled automation with a pre-approved grant; save a flowlet; leave a
   thread.
3. Kill and restart the server → automation, grant, thread, saved flowlet all survive.
4. With no tab open, the schedule fires unattended; the run appears in history with the
   grant honored (no re-approval).
5. Repeat with `DATABASE_URL` → real Supabase project.
6. On a deployed host: one live Composio trigger (e.g. Gmail) fires an automation end-to-end
   via the webhook route.

Plus standing bar: tests/typecheck green, docs synced (quickstart + new persistence/deploy
page), browser screenshots for anything UI.

## Out of scope (explicit)

- SQLite/D1/Turso dialects (Postgres-only decision).
- Composio trigger polling for unreachable hosts.
- Multi-tenant embedded world (schema is ready; behavior stays single-tenant).
- Cloud-phase retention/pruning policy (retain-everything ruling stands).
