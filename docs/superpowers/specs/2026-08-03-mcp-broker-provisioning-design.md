# Hosted MCP broker — provisioning and management

**Date:** 2026-08-03
**Status:** Designed with Yousef (this session); awaiting his review of this doc
**Context:** The broker service (`vendo-web/services/broker`) is fully built,
tested, and deployed at `*.mcp.vendo.run` (Railway, wildcard TLS). Every
tenant 404s because nothing ever calls its admin API — no console page, no
CLI, no automation. This design adds the missing last mile: how tenants come
to exist and how customers manage them. It changes nothing about the broker's
OAuth surface or the OSS door.

## Decisions made with Yousef

1. **Subdomain-per-tenant stays.** `{slug}.mcp.vendo.run` scales at zero
   marginal cost: one wildcard DNS record (DNS-only, straight to Railway) and
   one wildcard cert cover every tenant. The per-hostname Cloudflare charge
   he was worried about applies only to Cloudflare for SaaS (customers
   bringing their own domains like `mcp.maplebank.com`) — $0.10/hostname/mo
   after 100 free, an optional later add-on, not v1.
2. **Provisioning is automatic (adapter rule).** A host with `mcp` enabled +
   `VENDO_API_KEY` set + no explicit `remoteAs` gets a tenant at composition,
   the same way the key fills the store/sandbox/inference slots. No human
   step, no copy-pasted secret.
3. **Management surface = console page (his call: B).** The page manages
   tenants, never creates them: status + kill switch + rotate secret +
   revoke-all-sessions + the upstream pointer. Rationale: a hosted public
   auth surface without a customer-visible off switch is a bad security
   story, and the broker's admin operations already exist server-side — the
   page is UI plus thin proxy routes.

## Architecture (who talks to whom)

```
host app compose (createVendo, key set, mcp enabled, no remoteAs)
   │  POST console /api/v1/mcp/tenant  { baseUrl: VENDO_BASE_URL }   (key auth)
   ▼
console  ──ensures──▶  broker admin API (POST /admin/tenants, BROKER_INTERNAL_TOKEN path already exists via key introspection)
   │  ◀── one-time federation_secret (first provision or rotate only)
   ▼
host persists secret via the secrets seam; door flips to remoteAs+federation
   pointing at https://{slug}.mcp.vendo.run
```

- The host→console channel is the already-authenticated Cloud channel
  (`cloudKeyOptions`); the secret never rides anything else and no human
  sees it.
- The console→broker channel is the broker's existing admin API; the console
  is its only caller (the broker already authenticates provision calls by
  introspecting a `vnd_` key against the console — that seam is built).
- Idempotent: "ensure" returns the existing tenant when one exists.
- **Amendment (plan-time simplification):** the federation secret is
  returned on EVERY ensure call, not only the first. Rationale: the host
  has nowhere durable to persist it — the hosted store structurally
  excludes secrets, and serverless hosts have no disk — and the keyed
  console channel already serves secret material (`cloudSecrets` GET does
  exactly this today), so returning it per-ensure adds zero new exposure:
  anyone holding the org key could fetch it anyway. This also makes
  rotation instant: rotate invalidates the old secret and the host's next
  ensure (boot, redeploy, or a future re-ensure-on-401) picks up the new
  one — no "pending pickup" state machine. Broker stores it encrypted at
  rest exactly as today; decrypt happens only inside the ensure path.

## Components

### 1. OSS umbrella (flowlet)
- New selection at the composition seam, cloned from `selectConnections`:
  explicit `mcp.remoteAs` config always wins → key present + `mcp` enabled +
  `VENDO_BASE_URL` public → cloud broker default (ensure-tenant call, wire
  `remoteAs` + `federation` from the response) → neither → today's local
  door, unchanged.
- **Dev/localhost rule:** no `VENDO_BASE_URL`, or one the broker cannot
  reach (localhost/private), skips the broker default silently and keeps the
  local door — the broker cannot forward visitors to a laptop. Doctor
  explains (new check: key + mcp + no public base URL → "broker available
  when deployed").
- Doctor + `/status` surface the tenant URL when the broker is active.

### 2. Console (vendo-web)
- `POST /api/v1/mcp/tenant` (key-gated like every data-plane route):
  ensure-tenant. Chooses the slug, calls the broker admin API, stores the
  tenant↔org/project mapping, returns `{ issuer, audience, jwksUri,
  federationSecret? }`.
- Management page (project-scoped): tenant URL + status, upstream pointer
  (`upstream_origin` — the customer's deployment URL), disable/enable,
  rotate secret, revoke-all-sessions, last-seen traffic.
- Proxy routes for the page's actions → broker admin API.

### 3. Broker (vendo-web/services/broker)
- Exists already: provision, delete, revoke-all, key introspection.
- New: **rotate-secret** endpoint (mint new secret, re-encrypt, return once;
  old secret invalid immediately) and **disable/enable** (status flip —
  schema already has `status`; today only `active` rows resolve).
- New: **update upstream** (host redeployed to a new URL → ensure call
  carries the new `baseUrl`; broker updates the pointer).

## Slug choice (flagged call, my pick)

Derived from the project name, sanitized to the broker's slug rules,
uniqueness enforced by the existing `broker.tenants.slug` unique constraint;
on collision, append a short suffix. Customer-visible and changeable later
from the console page (a rename = provision new slug + retire old; sessions
reset — acceptable, rare). Not asked of the operator at provision time —
zero-config comes first; rename is the escape hatch.

## What v1 does NOT include

- Custom domains (`mcp.maplebank.com`) — Cloudflare for SaaS add-on, later.
- Registry submission automation (separate parked item, 10-mcp §169).
- Any change to the door's OAuth behavior, PKCE flows, or the federation
  handshake — both sides are built and live-proven; this design only
  creates tenants and manages them.
- Metering beyond traffic last-seen (no new meter in v1; charter allows
  adding one later without protocol change).

## Testing / proof

- Broker: rotate + disable + update-upstream endpoint tests alongside the
  existing 19-file suite; provisioning idempotency test.
- Console: ensure-tenant route tests (slug collision, idempotent re-ensure,
  secret-once semantics) on the PGlite harness.
- OSS: selection-seam tests cloned from the connections suite (explicit wins,
  key default, localhost skip, secret persisted once).
- **End-to-end live proof (the demo Yousef wanted all along):** deployed
  Maple + key → tenant exists → connect Claude to `maple.mcp.vendo.run` →
  OAuth → tool call lands in Maple's audit log — recorded, no hand-curl
  anywhere.
