# Hosted store — one-pager

Date: 2026-07-18
Status: DRAFT for Yousef's review (write-once decision doc, not living law)

## What it is

A multi-tenant Postgres behind an HTTP API that the OSS `hostedStore` adapter
speaks. With `VENDO_API_KEY` set and the `hosted-storage` entitlement present,
the umbrella composes `hostedStore()` instead of `createStore()` — Vendo data
(apps, threads, runs, grants, approvals, audit, state, sessions) lives with
Vendo. Tenant = the key's org, resolved through the existing key-validation +
entitlements path (`/api/v1/keys/validate`, entitlements contract v2, cached
TTL). BYO-Postgres (`createStore`) remains, single-player only.

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
  request body. Key rotation re-resolves via the cached entitlements lookup.
- Orgs re-home here eventually (kill-list A5 cut them from OSS); v1 needs only
  tenant = key's org — no membership model yet.
- Soft quotas per org at launch (rows, blob bytes, requests/s); 402 with
  `cloud-required` past hard caps, consistent with the existing envelope.
- Residency: single US region at launch; EU later as a per-org region pin.
  State it on the pricing page, don't build it yet.
- Retention/erase parity with OSS: the erase endpoint cascades exactly like
  `eraseStore`, so a swept subject leaves zero rows — same guarantee, hosted.

## Seam split

- **OSS (this repo):** `hostedStore(config)` in `packages/store` — a
  fetch-backed `StoreAdapter` (~one file plus tests), reusing the cloud.ts
  error mapping. Umbrella composition: key present + entitlement →
  `hostedStore`, else `createStore`. Conformance: the existing store adapter
  conformance suite runs against it via an in-memory fake of the HTTP API.
- **vendo-web (private):** the service — Postgres schema (org-scoped mirror of
  `packages/store/src/schema.ts`), the routes above beside the existing
  broker/key-validation code, metering, migrations. Ships behind the
  `hosted-storage` entitlement flag.

## Open questions

1. **Postgres substrate.** The broker runs on Cloudflare Workers, which can't
   embed Postgres. Recommendation: managed Postgres (Neon or similar) reached
   via Hyperdrive from the existing broker — no new deploy target.
2. **Blob transport.** Raw bytes through the API vs presigned object-storage
   URLs. Recommendation: raw bytes now (blobs today are app docs and small
   artifacts); revisit presigned R2 URLs only when size or egress cost says so.
3. **Entitlement granularity.** Single `hosted-storage` boolean vs metered
   tiers at launch. Recommendation: boolean + soft quotas; wire metering into
   pricing tiers only after real usage exists.
