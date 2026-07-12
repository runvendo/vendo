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
| `vendo_approvals` | `id, subject, request, status, decided_at, created_at` | approval queue |
| `vendo_audit` | `id, at, kind, subject, venue, presence, app_id, tool, event` | append-only audit log |
| `vendo_runs` | `id, app_id, trigger, status, record, started_at, finished_at` | automation run records |
| `vendo_secrets` | `name, ciphertext, created_at` | optional encrypted secret values |

Collection names are opaque to the adapter. App storage uses `app:<appId>:<name>` by convention. The principal-free `records()` and `blobs()` seams do not route ephemeral data; consuming blocks are responsible for that routing.
