# @vendoai/store

`@vendoai/store` implements the `@vendoai/core` persistence seams with one Postgres schema. It uses PGlite for a zero-config local database and the same schema on a hosted Postgres service.

Read [Persistence](https://docs.vendo.run/deploy/persistence).

```ts
import { createStore } from "@vendoai/store";

const store = createStore({ dataDir: ".vendo/data" });
await store.ensureSchema();
```

For production, pass a Postgres connection string explicitly, for example `createStore({ url: process.env.POSTGRES_URL })`. Without `url`, PGlite stores durable data in `dataDir` (default `.vendo/data`); `memory://` is also supported. PGlite is rejected on known serverless filesystems.

## Tables

| Table | Key columns (stable) | Holds |
| --- | --- | --- |
| `vendo_meta` | `key, value` | schema version, boot id |
| `vendo_apps` | `id, subject, enabled, doc, created_at, updated_at` | each user's app document and ownership |
| `vendo_records` | `collection, id, data, refs, created_at, updated_at, revision` | app data collections; `refs` is GIN-indexed for host joins; `revision` backs atomic writes |
| `vendo_blobs` | `namespace, key, bytes, content_type, created_at` | file storage, exports, screenshots |
| `vendo_state` | `app_id, subject, data, updated_at` | built-in per-user-per-app state singleton |
| `vendo_threads` | `id, subject, messages, created_at, updated_at` | conversation threads |
| `vendo_grants` | `id, subject, tool, descriptor_hash, scope, duration, app_id, source, granted_at, revoked_at, expires_at` | permission grants |
| `vendo_approvals` | `id, subject, request, status, decided_at, session_id, consumed_at, created_at` | approval queue |
| `vendo_audit` | `id, at, kind, subject, venue, presence, app_id, tool, event` | append-only audit log |
| `vendo_runs` | `id, app_id, trigger, status, record, started_at, finished_at` | automation run records |
| `vendo_secrets` | `name, ciphertext, created_at` | optional encrypted secret values |
| `vendo_mcp_clients` | `id, data, refs, created_at, updated_at` | door-owned MCP client state |
| `vendo_mcp_grants` | `id, data, refs, created_at, updated_at` | door-owned MCP grant state |
| `vendo_sessions` | `subject, touched_at` | ephemeral (anonymous) session registry: last-activity touch per session, read by the TTL sweep |

App storage uses `app:<appId>:<name>` by convention. App-scoped record and blob WRITES require an existing `vendo_apps` row and fail closed with `not-found` ("session may have expired") when there is none — the app never existed, or its ephemeral session was swept; reads on a missing app return empty. Except for the reserved names below, collection names remain opaque and use `vendo_records`; non-`app:`-prefixed collections and namespaces have no principal linkage.

Generic record collections and the two door-owned tables expose the optional
`RecordStore.claim` capability: one database statement compares the current
`data` and `refs`, then replaces or deletes the row. Exactly one concurrent
claimant receives `true`.

Ordinary record collections expose optional `records(collection).atomic` operations: `insertIfAbsent(record)` for one-winner claims and `compareAndSwap(record, expectedRevision)` for revision-guarded updates. Both PGlite and hosted Postgres use the same atomic SQL. The capability is optional at the core seam and reserved typed-table routes may omit it.

## Reserved collections (block seam)

Blocks receive core's plain `StoreAdapter`, so these exact `records()` collection names route to their typed tables:

| Collection | Primary key | Data | Synthesized refs | Record timestamps |
| --- | --- | --- | --- | --- |
| `vendo_grants` | grant id | `PermissionGrant` | `subject`, `tool`, optional `app_id` | `grantedAt` / `revokedAt ?? grantedAt` |
| `vendo_approvals` | approval id | `{ request, status, decidedAt?, sessionId?, consumedAt? }` | `subject`, `status` | `request.createdAt` / `consumedAt ?? decidedAt ?? request.createdAt` |
| `vendo_audit` | audit event id | `AuditEvent` | `subject`, `kind`, optional `app_id`, optional `tool` | `at` / `at` |
| `vendo_threads` | thread id | `{ subject, messages }` | `subject` | table `created_at` / `updated_at` |
| `vendo_runs` | run id | `{ appId, trigger, status, record, startedAt, finishedAt? }` | `app_id`, `status` | `startedAt` / `finishedAt ?? startedAt` |
| `vendo_apps` | app id | `{ subject, enabled, doc }` | `subject` | table `created_at` / `updated_at` |
| `vendo_mcp_clients` | client id | block-internal JSON | caller-supplied, arbitrary keys | table `created_at` / `updated_at` |
| `vendo_mcp_grants` | grant id | block-internal JSON | caller-supplied, arbitrary keys | table `created_at` / `updated_at` |

Typed reserved writes validate their data, require embedded ids to match the record id, and upsert the typed row — with two enforced exceptions. `vendo_audit` is append-only: `put` on an existing id and `delete` are both refused; audit rows are erased only through the erase API below. `vendo_apps`, `vendo_grants`, and `vendo_threads` refuse cross-subject flips atomically: a put whose id already belongs to another subject fails with a conflict. The data is authoritative: caller-supplied `refs` are ignored on write and synthesized from typed columns on read. Their routed `list({ refs })` accepts only the refs shown above. The two door-owned collections use generic record semantics in dedicated tables: the store does not validate their block-internal payloads, and refs filters accept arbitrary keys. Generic and routed record lists are uniformly newest-first by `(createdAt, id)`.

Ephemeral principals take the SAME path as everyone else: their rows are ordinary disk rows under their subject. What makes a session ephemeral is its registration (`registerEphemeralSubject`); see the lifecycle section below.

## Ephemeral session lifecycle

Ephemeral (anonymous) principals write ordinary disk rows under their subject; the session itself is one row in `vendo_sessions`. `registerEphemeralSubject(store, subject, now?)` (async) upserts the touch row — registration == touch — and the umbrella calls it on every ephemeral-principal request, so idle time is measured from the last request, reads included. Data written for a subject that is never registered behaves like durable data (nothing sweeps it); the erase API below remains the cleanup path for such compositions.

`sweepEphemeralSubjects(store, { idleMs, now? })` (async) erases every registered session idle for at least `idleMs` through the erase cascade — the subject's apps, records, blobs, state, threads, grants, approvals, audit, runs, and the session row itself — and returns the swept subjects so the caller can cascade further (the umbrella forwards them to `agent.evictSubject`). TTL policy is the caller's — the store stays config-free; `createVendo({ sessions })` owns the knobs and the sweep cadence.

Writes after a sweep fail closed. App-scoped (`app:<appId>:<name>`) record and blob writes require an existing `vendo_apps` row; a write against a missing app — one that never existed or whose session was swept — throws `not-found` ("session may have expired") instead of recreating rows no cascade would reach again. Reads on missing apps return empty.

Because the registry is a table in the same database, sessions survive restarts and are shared across instances — no sticky-session constraint. Anonymous audit events live in `vendo_audit` like any others and appear in `auditStore.export()` until their session is swept.

`adoptEphemeralSubject(store, from, to)` is the anonymous-to-signed-in merge: threads, apps (with their app-scoped records/blobs), and state move to the signed-in subject; grants, approvals, audit, and the adopted apps' run history are deleted — consent and history do not transfer. Idempotent; nothing is ever stolen from an existing durable row.

## Encryption

`createStore({ encryption: { key } })` (base64 32-byte key) encrypts `vendo_secrets.ciphertext` with AES-256-GCM; everything else stays host-queryable plaintext by design. The composed default is on: `vendo init` provisions `VENDO_STORE_ENCRYPTION_KEY` into the host's `.env` and `createVendo` reads it when no store is passed. Ciphertext is bound to its secret name via AAD (`v2` envelope).

## Retention and erasure

`eraseStore(store)` is the store-level erase API — `bySubject(subject)` for full erasure and `byApp(appId)` — cascading the matching rows across all 14 tables (ephemeral subjects included — their rows are ordinary disk rows) and returning per-table deleted counts. It is the only sanctioned deletion path for `vendo_audit` rows. It is also re-exported from `@vendoai/vendo/server`. Host SQL remains available for everything else.
