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

App storage uses `app:<appId>:<name>` by convention. When the owning app is ephemeral, generic record collections and blob namespaces following that convention stay entirely in the session's in-memory overlay. Except for the reserved names below, collection names remain opaque and use `vendo_records`; non-`app:`-prefixed collections and namespaces have no principal linkage and therefore keep their normal persistence behavior.

Generic record collections and the two door-owned tables expose the optional
`RecordStore.claim` capability: one database statement compares the current
`data` and `refs`, then replaces or deletes the row. Exactly one concurrent
claimant receives `true`.

Ordinary record collections expose optional `records(collection).atomic` operations: `insertIfAbsent(record)` for one-winner claims and `compareAndSwap(record, expectedRevision)` for revision-guarded updates. Both PGlite and hosted Postgres use the same atomic SQL, and the ephemeral overlay mirrors it. The capability is optional at the core seam and reserved typed-table routes may omit it.

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

Ephemeral approvals and audit events route automatically from their embedded principal. For grants, threads, apps, and other subject-only writes, call `registerEphemeralSubject(store, subject)` before the first write, unless an earlier principal-bearing ephemeral write already registered that subject. Runs and `app:<appId>:<name>` record/blob storage inherit routing from their owning app. Routed, typed-helper, and app-convention generic storage share in-memory overlays, and `close()` clears them. Other blob namespaces remain principal-free and are not routed automatically.

`stateStore.get()` and every principal-bearing helper operation register ephemeral subjects as a side effect. This is by design: the caller's `principal.ephemeral` flag is authoritative, and registration caches it so later subject-only writes (for example, routed grants) stay off disk.

`auditStore.export()` reads only the durable audit log. Ephemeral session events appear in `query()` but are never included in exports, by design.

## Ephemeral session lifecycle

Registered ephemeral subjects form a TTL session registry. `registerEphemeralSubject(store, subject, now?, cap?)` both declares the subject ephemeral and stamps its touch time (registration == touch). The registry is a bounded LRU (default cap `EPHEMERAL_SUBJECT_CAP`, 10 000; `setSessionCap` changes the default the overlay enforces — the umbrella wires `sessions.maxSessions` there); over-cap registration evicts the oldest not-inflight subject through the full cascade below, never a key-only drop and never a session with a request mid-turn (if every other subject is inflight, the registry temporarily exceeds the cap instead).

`sweepEphemeralSubjects(store, { idleMs })` evicts every registered subject idle for at least `idleMs` with no in-flight request and returns the evicted subjects so the caller can cascade further (the umbrella forwards them to `agent.evictSubject`). `beginEphemeralRequest`/`endEphemeralRequest` bracket a request so the sweep never evicts a session mid-turn, however long it streams. TTL policy is the caller's — the store stays config-free; `createVendo({ sessions })` owns the knobs and the sweep cadence.

Eviction is a synchronous cascade: `evictEphemeralSubject(store, subject)` clears every overlay map of exactly that subject's data — apps, state, threads, grants, approvals, audit, runs, and app-scoped records/blobs via the owned app ids — with no awaits in between, so no concurrent request observes a half-evicted session. Nothing durable is touched: while a subject is registered none of its writes reach disk, so an evicted session has zero on-disk rows by construction.

Writes after eviction fail closed. App-scoped (`app:<appId>:<name>`) record and blob operations resolve the owning app to ephemeral, durable, or unknown (`appEphemerality`); a write against an unknown app — one that never existed or whose session was evicted — throws `not-found` ("session may have expired") instead of quietly persisting a durable row. Reads on unknown apps return empty.

The overlay, and therefore the registry, is per-process memory. Multi-instance deployments must pin an anonymous client to one instance (sticky sessions) or accept that each instance holds an independent session; there is no cross-process session state.

`setSessionClock(store, clock)` points touch/TTL at an injected clock (the umbrella wires `sessions.now` here). `ephemeralOverlaySizes(store)` reports overlay map sizes — a test seam, not a production surface.

## Encryption

`createStore({ encryption: { key } })` (base64 32-byte key) encrypts `vendo_secrets.ciphertext` with AES-256-GCM; everything else stays host-queryable plaintext by design. The composed default is on: `vendo init` provisions `VENDO_STORE_ENCRYPTION_KEY` into the host's `.env` and `createVendo` reads it when no store is passed. Ciphertext is bound to its secret name via AAD (`v2` envelope).

## Retention and erasure

`eraseStore(store)` is the store-level erase API — `bySubject(subject)` for full erasure and `byApp(appId)` — cascading the matching rows (durable and ephemeral-overlay alike) across all 13 tables and returning per-table deleted counts. It is the only sanctioned deletion path for `vendo_audit` rows. It is also re-exported from `@vendoai/vendo/server`. Host SQL remains available for everything else.
