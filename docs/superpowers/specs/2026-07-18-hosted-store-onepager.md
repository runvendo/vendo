# Hosted store — one-pager

Date: 2026-07-18
Status: ACCEPTED 2026-07-17 (Yousef, via the cloud-definition brainstorm; Q1/Q2
as recommended, Q3 amended — see Decisions). Amended to match the realignment
lane: the entitlement protocol and validate endpoint no longer exist.

## What it is

A multi-tenant Postgres behind an HTTP API that the OSS `hostedStore` adapter
speaks. With `VENDO_API_KEY` set and no explicit
store passed, the umbrella composes `hostedStore()` instead of `createStore()`
(adapter rule: the key fills only unset slots; an explicitly passed store
always wins) — Vendo data (apps, threads, runs, grants, approvals, audit,
state, sessions) lives with Vendo. Tenant = the key's org, resolved
server-side on every call, never from the request body. BYO-Postgres
(`createStore`) remains forever (hard BYO rule).

From OSS's perspective the hosted backend is just another `StoreAdapter`
(`packages/core/src/store.ts`). The service is dumb storage: it persists rows
and bytes, nothing else.

## API shape

RPC-over-HTTP mirroring the `StoreAdapter` surface, method for method. The
TypeScript types ARE the contract — bodies are the method arguments, responses
the return values, same client pattern as `packages/apps/src/cloud.ts`
(Bearer `VENDO_API_KEY`, `{ error: { code, message } }` envelope, 402 →
`cloud-required`). Base: `VENDO_CLOUD_URL` (default `https://console.vendo.run`).

Records — `POST /api/v1/store/records/:collection/<method>`:
`get` · `put` · `delete` · `list` · `claim` ·
`atomic/insert-if-absent` · `atomic/compare-and-swap`

Blobs — `/api/v1/store/blobs/:namespace/:key`:
`PUT` (raw bytes + Content-Type) · `GET` · `DELETE`, and
`GET /api/v1/store/blobs/:namespace?prefix=` for list.

Erase — `POST /api/v1/store/erase` (subject cascade, 02-store §5 semantics —
the ephemeral-session TTL sweep still runs host-side and calls this).

Sessions — `POST /api/v1/store/sessions/register|adopt|stale|claim`
(amendment, 2026-07-18 fix round): the ephemeral registry doors (02-store §4).
`register` == touch on every ephemeral request; `adopt` runs the
anonymous→signed-in merge server-side (the engine's adoptEphemeralSubject);
`stale` + `claim` are the list and mutual-exclusion legs of the HOST-driven
TTL sweep, which finishes each claimed subject through the erase endpoint
above. Registry writes are never gated on the storage quota.

Bodies are capped server-side: 8 MB for record JSON and blob bytes, 64 KB for
erase/session bodies; larger payloads answer the standard validation envelope.

`ensureSchema()` is a client-side no-op; the service owns its migrations.
Reserved-collection semantics (`vendo_audit` append-only, `vendo_state` id
grammar, `vendo_threads` revisions) are enforced server-side, same rules as
`packages/store/src/routing.ts`.

## What does NOT change

- **The guard runs host-side.** Judge, consent, approvals logic all stay in the
  host process. The hosted store never evaluates policy; it stores the rows.
- **Secrets NEVER leave the host.** Today `vendo_secrets` is AES-encrypted with
  a host-held key via `createStore({ encryption: { key } })`, and
  `storeSecrets`/`secretStore` are functions of the local `VendoStore` handle —
  they cannot route to a plain `StoreAdapter`. That stays true by construction:
  the hosted API has no secrets endpoints, and `vendo_secrets` is not a
  syncable collection. Secrets stay in `envSecrets` or the local store.
- **Sandbox/egress model.** Generated code still runs in the host's sandbox;
  the hosted store is a data plane, not an execution venue.
- **The OSS seam.** `StoreAdapter` is unchanged; everything downstream of it
  (runtime, apps, ui) is oblivious to which store it got.

## Tenancy, limits, residency

- Every row carries `org_id`; the org comes from the API key, never the
  request body. Key rotation takes effect on the next call — there is no
  client-side entitlement cache.
- Orgs re-home here eventually (kill-list A5 cut them from OSS); v1 needs only
  tenant = key's org — no membership model yet.
- Soft quotas per org at launch (rows, blob bytes, requests/s); 402 with
  `cloud-required` past hard caps, consistent with the existing envelope.
- Residency: single US region at launch; EU later as a per-org region pin.
  State it on the pricing page, don't build it yet.
- Retention/erase parity with OSS: the erase endpoint cascades exactly like
  `eraseStore`, so a swept subject leaves zero rows — same guarantee, hosted.

## Seam split

- **OSS (this repo):** `hostedStore(config)` in `packages/vendo` (amendment,
  2026-07-18: placed beside the other Cloud adapters rather than
  `packages/store` — it shares their deployment-identity headers and error
  table, and `packages/store` sits below `packages/vendo` in the layering, so
  the store package only exports its reserved-collection lists for the
  capability mirror). A fetch-backed `StoreAdapter` plus the erase and
  session doors, reusing the `cloudSandbox` error-mapping table. Umbrella
  composition via a `selectStore` seam cloned from `selectConnections`:
  explicit store wins, else key → `hostedStore`, else `createStore`; the
  ephemeral-session operations travel with the selected store (SQL registry
  locally, the session doors when hosted). Conformance: the existing store
  adapter conformance suite runs against it via an in-memory fake of the
  HTTP API.
- **vendo-web (private):** the service — Postgres schema (org-scoped mirror of
  `packages/store/src/schema.ts`), the routes above beside the existing
  broker/key-introspection code, metering, migrations. Gated by valid key +
  `storage_gb` quota — no entitlement flag (2026-07-17 decision: no capability
  booleans anywhere).

## Decisions (Yousef, 2026-07-17)

1. **Postgres substrate — accepted as recommended.** Managed Postgres (Neon or
   similar) reached via Hyperdrive from the existing broker — no new deploy
   target.
2. **Blob transport — accepted as recommended.** Raw bytes through the API
   now; revisit presigned R2 URLs only when size or egress cost says so.
3. **Gating — amended.** No `hosted-storage` boolean, no entitlement flag of
   any kind. A valid key gets the hosted store; `storage_gb` soft quotas do
   the limiting, with the standard quota-exhausted error past caps. Metered
   pricing tiers wire in only after real usage exists.
