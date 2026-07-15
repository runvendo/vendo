# @vendoai/store

`@vendoai/store` implements the `@vendoai/core` persistence seams with one Postgres schema. It uses PGlite for a zero-config local database and the same schema on a hosted Postgres service.

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
| `vendo_records` | `collection, id, data, refs, created_at, updated_at` | app data collections; `refs` is GIN-indexed for host joins |
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

Typed reserved writes validate their data, require embedded ids to match the record id, and upsert the typed row. The data is authoritative: caller-supplied `refs` are ignored on write and synthesized from typed columns on read. Their routed `list({ refs })` accepts only the refs shown above. The two door-owned collections use generic record semantics in dedicated tables: the store does not validate their block-internal payloads, and refs filters accept arbitrary keys. Generic and routed record lists are uniformly newest-first by `(createdAt, id)`.

Ephemeral approvals and audit events route automatically from their embedded principal. For grants, threads, apps, and other subject-only writes, call `registerEphemeralSubject(store, subject)` before the first write, unless an earlier principal-bearing ephemeral write already registered that subject. Runs and `app:<appId>:<name>` record/blob storage inherit routing from their owning app. Routed, typed-helper, and app-convention generic storage share in-memory overlays, and `close()` clears them. Other blob namespaces remain principal-free and are not routed automatically.

`stateStore.get()` and every principal-bearing helper operation register ephemeral subjects as a side effect. This is by design: the caller's `principal.ephemeral` flag is authoritative, and registration caches it so later subject-only writes (for example, routed grants) stay off disk.

`auditStore.export()` reads only the durable audit log. Ephemeral session events appear in `query()` but are never included in exports, by design.
