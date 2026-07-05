# Runtime seam contracts

The portable runtime (`@vendoai/runtime`, architecture Decision 1) never imports a database, queue, or HTTP server — it depends on five injected seams. Interfaces live in `packages/vendo-core/src/seams/`; embedded (in-memory/in-process) implementations of all five ship in `@vendoai/runtime`'s `embedded` module, and the runtime's dependency-guard test (`packages/vendo-runtime/src/dependency-guard.test.ts`) plus demo-bank keep the embedded guarantee honest in CI.

| Seam | Purpose | Embedded impl | Cloud impl |
|---|---|---|---|
| `Store` | threads, saved vendos, automations, audit | host's choice (in-memory/SQLite in CI) | Postgres in apps/cloud |
| `CredentialBroker` | how a tool call gets user identity | host session, in-process | vouch JWT + RFC 8693 token exchange |
| `Executor` | where a tool call physically runs | in-process | client executor (browser) / server executor (worker) |
| `Scheduler` | firing automations when the user is away | none or host cron | pg-boss worker |
| `Channels` | reaching the user off-thread | in-app only | in-app now; SMS/voice later |

Everything is scoped by `Principal` (`tenantId` + `subject` + vouch claims). Timestamps are ISO 8601 strings.

## Store

Aggregates one sub-store per concern: `threads` (persisted `VendoUIMessage` streams), `vendos` (saved UI tree + bound tool query + originating prompt), `automations` (records + run history), `audit` (append-only `AuditEvent` union: tool execution, approval, grant exchange, firing — written from day 1; audit UI comes later). The store owns identity and timestamps: `create`/`save` callers never supply `id`, `createdAt`, or `updatedAt`.

Deferred on purpose: the automation `spec` field was `unknown` until the automations DSL froze; memory has no member yet — adding one later is additive.

## CredentialBroker

Two operations for the two credential lifetimes it owns: `authenticate(credential)` turns the SDK-presented credential into a verified `Principal` at session init; `acquireGrant(request)` exchanges a signed assertion for a short-lived scoped token for one automation run. Interactive host-API calls need nothing from this seam — the browser executes them on the user's existing session (Decision 2).

## Executor

`execute(call, context) → { ok: true, result } | { ok: false, error }` — one outcome per call, non-streaming, discriminated on `ok` (so a legitimate `undefined` result never mis-narrows as an error). Policy has already evaluated the call before any executor sees it. `context.grant` is present only on server-executed automation runs.

## Scheduler

Time-based triggers only (`cron` / `at`); the runtime registers one firing handler. `schedule` takes the `Principal` scope, which the scheduler persists and replays on every `AutomationFiring` — the handler needs it to load the record (Store is Principal-scoped) and acquire the brokered grant. Host webhooks and Composio triggers are ingest paths that invoke the same handler directly — they don't pass through the Scheduler.

## Channels

Message-shaped `deliver` for `in-app` and `sms`. Realtime voice is a session, not a message — it gets its own contract.
