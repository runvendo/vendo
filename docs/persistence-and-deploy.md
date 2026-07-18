# Persistence and deployment

Vendo uses Postgres only. Development defaults to embedded PGlite at
`.vendo/data`; production points the same schema at Postgres.

## Store configuration

```ts
import { createStore } from "@vendoai/vendo/server"; // or "vendoai/server"

export function createStore(config?: {
  url?: string;
  dataDir?: string;
  encryption?: { key: string };
  allowUnencryptedSecrets?: boolean; // dev-mode only; never set in production
}): VendoStore;
```

The umbrella re-exports the store runtime — `createStore`, `envSecrets`,
`storeSecrets`, and `secretStore` — from `@vendoai/vendo/server`, so a
production deploy needs no direct `@vendoai/store` install:

```ts
import { createStore, createVendo } from "@vendoai/vendo/server";

const store = createStore({ url: process.env.DATABASE_URL });
await store.ensureSchema();
const vendo = createVendo({ model, principal, store });
```

Omit `url` to use PGlite. `dataDir` defaults to `.vendo/data`. When `url` is
set, `dataDir` is ignored. Call `ensureSchema()` during boot; migrations are
idempotent and forward-only within the version train.

`encryption.key` is a base64 32-byte AES-256-GCM key for `vendo_secrets` only.
App data remains plaintext so hosts can query and join it. Database and disk
encryption remain the host's responsibility.

Encryption is production-owned: set `VENDO_STORE_ENCRYPTION_KEY` in your
deploy environment and `createVendo` reads it when no store is passed. Without
a key, development stores secrets unencrypted in the gitignored local data dir
(`plain@1:` envelope) while production secret writes fail closed with
instructions. Ciphertext is bound to its secret name (AES-GCM AAD, versioned
envelope), so a ciphertext swapped between rows fails to decrypt; plaintext
rows written before a key existed keep reading after one is added. Never
rotate the key by hand — existing ciphertext would be orphaned.

## Public table map

| Table | Stable key columns | Holds |
| --- | --- | --- |
| `vendo_meta` | `key, value` | schema version and boot id |
| `vendo_apps` | `id, subject, enabled, doc, created_at, updated_at` | each user's app |
| `vendo_records` | `collection, id, data, refs, created_at, updated_at` | app record collections |
| `vendo_blobs` | `namespace, key, bytes, content_type, created_at` | files, exports, and screenshots |
| `vendo_state` | `app_id, subject, data, updated_at` | per-user, per-app state singleton |
| `vendo_threads` | `id, subject, messages, created_at, updated_at` | conversation threads |
| `vendo_grants` | `id, subject, tool, descriptor_hash, scope, duration, app_id, source, granted_at, revoked_at, expires_at` | grants |
| `vendo_approvals` | `id, subject, request, status, decided_at, created_at` | approval queue |
| `vendo_audit` | `id, at, kind, subject, venue, presence, app_id, tool, event` | append-only audit log |
| `vendo_runs` | `id, app_id, trigger, status, record, started_at, finished_at` | automation runs |
| `vendo_secrets` | `name, ciphertext, created_at` | optional encrypted secrets |

All JSON columns use `jsonb`. `vendo_records.refs` is GIN-indexed. App storage
collections use `app:<appId>:<name>`.

```sql
SELECT ...
FROM invoices i
JOIN vendo_records r
  ON r.refs @> jsonb_build_object('invoice_id', i.id)
```

`subject` is the only partition axis. Ephemeral (anonymous) principals write ordinary rows under their subject; a TTL sweep erases sessions idle past `sessions.ttlMs`.

## Long-lived hosts

Call `automations.start()` to run the convenience timer around `tick()`. The
returned function stops the timer. Cron expressions use five fields and are
evaluated in UTC. A missed window fires once on the next tick and does not
back-fill.

Anonymous-session eviction needs no wiring: `createVendo` runs an unref'd
background timer (every `sessions.sweepIntervalMs`, default 60 s) that sweeps
idle sessions, and tears it down with `store.close()`.

## Serverless hosts

Schedule `POST /api/vendo/tick` from the platform cron. Send:

```http
Authorization: Bearer <secret>
```

The `/tick` endpoint is outside cookie auth and requires this bearer secret.
Use hosted Postgres for serverless deployment. Local PGlite files are suitable
for a durable single-process host, not an ephemeral filesystem.

Serverless platforms give no timer guarantee, so anonymous-session eviction
also runs amortized on request: any request arriving `sessions.sweepIntervalMs`
after the last sweep triggers one before it is handled.

## Host events and webhooks

Call the composition seam from the host code path that owns the event:

```ts
await vendo.emit("invoice.paid", invoice, principal);
```

External and host webhook deliveries enter through
`POST /api/vendo/webhooks/:source`. Every source registers verification during
wiring. Connector schemes use their signed headers. Self-minted subscriptions
use HMAC-SHA256 over `id.timestamp.rawBody`, accept timestamps within five
minutes, and deduplicate by delivery id. The secret never appears in a URL.

Verification failure returns 401, resolves no principal, starts no run, and
writes one audit event.

## Reverse proxies

Behind a reverse proxy (Railway, Fly, any TLS terminator), set `VENDO_BASE_URL`
to the product's public origin. Route-binding host tools execute against it as
the trusted origin, the anonymous-session cookie stays `Secure`, and the MCP
door derives its OAuth discovery metadata (issuer, endpoints, `resource`) and
token audience binding from it instead of the proxy-internal request URL.
Forwarded headers such as `X-Forwarded-Host` are never trusted.

## Operations

- Back up the `vendo_` tables with the host database.
- Apply retention with host SQL against the public tables, or use the erase
  API: `eraseStore(store)` (also exported from `@vendoai/vendo/server`) erases
  by subject, by app, or by age across all tables and returns per-table counts.
- `vendo_audit` is append-only through the store door; the erase API is its
  only deletion path (host SQL on the raw table still works for cron cleanup).
- Use `/status` as the live composition probe.
- Use run history and the stop endpoint as the automation kill switch.
- Keep `.vendo/data` out of source control.
