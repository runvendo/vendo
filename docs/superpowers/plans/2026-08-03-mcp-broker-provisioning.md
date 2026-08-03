# MCP Broker Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A keyed host with `mcp` enabled automatically gets a working tenant at `{slug}.mcp.vendo.run`, manageable from a console page — no hand-run curl anywhere.

**Architecture:** Host → console `POST /api/v1/mcp/tenant` (key-gated ensure, returns tenant + federation secret every call) → console → broker admin API (exists; gains rotate/status/update). Flowlet gains one selection seam cloned from `selectConnections` that wires `remoteAs`+`federation` from the ensure response. Console gains a project-scoped MCP management page over thin proxy routes.

**Tech Stack:** vendo-web: Next.js console + Hono broker (`services/broker`, own workspace) + Supabase/PGlite tests. flowlet: `@vendoai/vendo` umbrella seam + vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-mcp-broker-provisioning-design.md` (amended: secret returned on every ensure). Trace every task back to it.

---

## THE FROZEN WIRE CONTRACT (both workers build against this; neither may change it)

### Console route: `POST /api/v1/mcp/tenant` (key auth via `gateValidKey`)

Request (both fields required; 64KB cap like `/api/v1/users`):
```json
{ "baseUrl": "https://app.maplebank.com", "mount": "/api/vendo/mcp" }
```

Response 200 (ensure — idempotent; creates on first call):
```json
{
  "tenant": {
    "slug": "maple",
    "issuer": "https://maple.mcp.vendo.run",
    "audience": "https://maple.mcp.vendo.run/mcp",
    "status": "active",
    "upstreamOrigin": "https://app.maplebank.com",
    "upstreamMount": "/api/vendo/mcp"
  },
  "federationSecret": "<base64url>"
}
```
- `federationSecret` present on EVERY 200 (spec amendment). `status` is `"active" | "disabled"`; when `"disabled"`, `federationSecret` is still returned (host keeps composing; broker refuses traffic).
- If `baseUrl` differs from the stored `upstream_origin`, the ensure UPDATES the pointer (host redeployed to a new URL) and returns the updated tenant.
- 400 `validation` on non-`https://` baseUrl or invalid mount; 401/402 per the standard key gate.

### Broker admin API additions (auth identical to existing `POST /admin/tenants`: Bearer `vnd_` key introspected against console, org must own the tenant):

```
POST  /admin/tenants/:slug/rotate-secret   → 200 { "federation_secret": "<base64url>" }
POST  /admin/tenants/:slug/status          body { "status": "active" | "disabled" } → 200 { "ok": true }
PATCH /admin/tenants/:slug                 body { "upstream_origin"?: string, "upstream_mount"?: string } → 200 { "ok": true }
GET   /admin/tenants/:slug/secret          → 200 { "federation_secret": "<base64url>" }   (decrypt-on-read; console ensure path only)
```

### Localhost rule (flowlet side): the broker default is SKIPPED (silently, doctor explains) when `VENDO_BASE_URL` is unset OR its hostname is `localhost`, `127.0.0.1`, `::1`, `*.local`, or an RFC1918 address.

### Slug derivation (console side): lowercase project name → strip to `[a-z0-9-]`, collapse runs of `-`, trim leading/trailing `-`, cap 63 chars; must pass the broker's existing slug regex + reserved list; on uniqueness collision append `-2`, `-3`, …

---

## Worker A — vendo-web (broker endpoints, console route, page)

### Task A1: Broker — rotate-secret endpoint

**Files:**
- Modify: `services/broker/src/admin.ts` (TenantAdmin gains `rotateSecret(slug, key)`)
- Modify: `services/broker/src/app.ts` (route wiring next to the existing `/admin/tenants` block, lines ~56-60)
- Modify: `services/broker/src/repository/pg.ts` + `src/repository/memory.ts` (update ciphertext/iv for a slug)
- Test: `services/broker/tests/provisioning.test.ts` (extend the existing suite)

- [ ] Write failing tests: rotate returns a NEW secret (differs from provision's), old secret no longer verifies the federation JWS, unknown slug → 404, foreign org's key → 403/404 per the existing provision authz behavior, secret is returned exactly in `{ federation_secret }` shape.
- [ ] Implement: mint via the existing `randomBase64Url(32)`, encrypt via the existing `tenant-secrets.ts` AES-256-GCM path (AAD = tenant UUID, same as provision), single UPDATE.
- [ ] Run scoped suite green; commit.

### Task A2: Broker — status flip + upstream PATCH + secret GET

**Files:** same as A1.

- [ ] Failing tests: `status disabled` → tenant middleware 404s traffic on that slug (`app.ts:62-69` only resolves `status='active'` — pin that this now serves the kill switch); flipping back to `active` restores service; PATCH updates `upstream_origin`/`upstream_mount` with the same `^https://[^/]+$` validation as provision (`admin.ts:16-20`); GET secret returns the decrypted current secret and requires the same authz.
- [ ] Implement all three; repository methods in both pg and memory implementations.
- [ ] Scoped suite green; commit.

### Task A3: Broker migration — `project_id` column

**Files:**
- Create: `services/broker/supabase/migrations/20260803000000_tenant_project.sql`

```sql
alter table broker.tenants add column project_id uuid references public.projects(id) on delete cascade;
create unique index tenants_project_idx on broker.tenants (project_id) where project_id is not null;
```

- [ ] Failing test first (PGlite migration test — model on the existing pattern in `apps/console/tests/*-migration.test.ts`): one tenant per project enforced; existing rows unaffected (nullable).
- [ ] Provision accepts optional `project_id` and stores it (`admin.ts` schema + repositories).
- [ ] Commit. **Note in PR: broker migrations are applied by hand per `services/broker/README.md:121-143` — the deploy step below includes running it.**

### Task A4: Console — `POST /api/v1/mcp/tenant` (ensure)

**Files:**
- Create: `apps/console/app/api/v1/mcp/tenant/route.ts` (thin, model on `app/api/v1/users/[externalId]/route.ts`)
- Create: `apps/console/lib/api/mcp-tenant.ts` (handler: gate → slug-derive → broker calls)
- Create: `apps/console/lib/mcp-broker/client.ts` (server-side fetch wrapper for the broker admin API; base URL from `MCP_BROKER_URL` env, forwards the caller's `vnd_` bearer)
- Test: `apps/console/tests/mcp-tenant-api.test.ts`

- [ ] Failing tests (mock the broker client): first call provisions (slug derived from project name per the frozen rule; collision appends `-2`), returns tenant + secret; second call is idempotent (no re-provision, secret fetched via GET secret); baseUrl change PATCHes upstream; non-https baseUrl → 400 validation envelope; no/invalid key → standard 401.
- [ ] Implement. Slug sanitizer is a pure exported function — unit-test the edge cases (unicode name, all-symbols name → fallback `project`, 63-char cap).
- [ ] Suite green; commit.

### Task A5: Console — management page + proxy actions

**Files:**
- Create: `apps/console/app/(console)/p/[projectId]/mcp/page.tsx` (server component reading the tenant via the broker client)
- Create: `apps/console/app/(console)/p/[projectId]/mcp/actions.ts` (server actions: toggle status, rotate, revoke-all — each proxies the broker admin API; revoke-all uses the EXISTING `POST /admin/tenants/:slug/revoke-all`)
- Modify: the console sidebar config (nav entry under the project, near Settings — check `nav-config` current shape on fresh main first; pilot lesson 4: this file is a shared-conflict magnet, diff against main before merge)
- Test: `apps/console/tests/mcp-page-actions.test.ts`

- [ ] Failing tests for the three actions (broker client mocked; assert exact broker calls + member-auth via the page's RLS/session path, NOT vnd_ keys — page auth = console session like every other page; the broker client for page actions authenticates with the org's key fetched server-side or `BROKER_INTERNAL_TOKEN`-style — match how sandbox pages call hosted services today, check `lib/api/sandbox-handlers.ts` precedent and follow it).
- [ ] Page renders: tenant URL, status pill + toggle, upstream pointer, rotate button (confirm dialog: "agents reconnect on the host's next deploy"), revoke-all, empty state when no tenant yet ("appears when a keyed deployment with MCP enabled boots").
- [ ] UI matches console patterns (this is console UI — screenshot in the PR per repo rule).
- [ ] Suite green; commit.

### Task A6: vendo-web gates + PR

- [ ] Full gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` (console) AND the broker's own workspace gate (`services/broker`: `pnpm build/test/typecheck/lint`). Known pre-existing failure: `usage-daily-rollups-migration` — fails identically on clean main, not yours.
- [ ] **Gates run in the foreground and finish before the session ends** (pilot lesson 2: never background gates and end the turn).
- [ ] One PR to vendo-web main: broker endpoints + migration + console route + page. Screenshot of the page in the body. Do NOT merge — the independent checker runs first.

## Worker B — flowlet (selection seam, cloud client, doctor)

### Task B1: `cloudMcpTenant` client

**Files:**
- Create: `packages/vendo/src/cloud-mcp.ts` (model line-for-line on `packages/vendo/src/cloud-apps.ts` — same `cloudKeyFetch`, same error mapping: 401/402 → `cloud-required`, other non-2xx → store mapping)
- Test: `packages/vendo/src/cloud-mcp.test.ts`

- [ ] Failing tests: posts `{ baseUrl, mount }` to `/api/v1/mcp/tenant`, returns the parsed frozen-contract response; 401 → `VendoError("cloud-required")`; malformed 2xx body → `not-implemented` (same posture as `knowledge/src/cloud.ts:70`).

Reference shape:
```ts
export interface McpTenant {
  slug: string; issuer: string; audience: string;
  status: "active" | "disabled";
  upstreamOrigin: string; upstreamMount: string;
}
export interface EnsureTenantResult { tenant: McpTenant; federationSecret: string; }
export function cloudMcpTenant(options: CloudKeyOptions): { ensure(input: { baseUrl: string; mount: string }): Promise<EnsureTenantResult> }
```

- [ ] Implement; scoped test green; commit.

### Task B2: the selection seam

**Files:**
- Modify: `packages/vendo/src/server.ts` — new `selectMcpBroker` placed with the other selectors (~lines 554-752), consumed where the door is composed (~lines 2147-2205). ADAPTER RULE comment cloned from `selectConnections` (`server.ts:702-713`).
- Create: `packages/vendo/src/mcp-broker-select.ts` if server.ts placement gets crowded — pure function, unit-testable: `(config.mcp, env, cloud) → { mode: "explicit" | "broker" | "local", ensure?: … }`
- Test: `packages/vendo/src/mcp-broker-select.test.ts`

Precedence (frozen): explicit `mcp.remoteAs` in config → used verbatim, no ensure call (adapter rule: explicit wins). Else `mcp` enabled + `VENDO_API_KEY` + public `VENDO_BASE_URL` → ensure at composition; wire `remoteAs: { issuer, audience }` + `federation: { secret }` from the response. Else → today's local door, byte-identical behavior.

- [ ] Failing tests: all three arms; the localhost rule (each listed host shape skips: unset, `localhost`, `127.0.0.1`, `::1`, `foo.local`, `10.x`, `192.168.x`, `172.16-31.x`); ensure failure at compose → loud warn + fall back to local door (composition must not die because the console blipped — same posture as the hosted-config fetch degrade at `server.ts:1469-1479`); `status: "disabled"` tenant → still composes remoteAs (broker refuses traffic; host side stays consistent).
- [ ] Implement; the ensure call is compose-time async — place it with the other awaited compose steps, NOT lazy (the door needs its trust anchor before the first request).
- [ ] `/status` wire (`wire/misc.ts` blocks section) reports `mcp: "local" | "broker" | false` following the connections-posture pattern (`wire/misc.ts:183`).
- [ ] Scoped tests green; commit.

### Task B3: doctor

**Files:**
- Modify: `packages/vendo/src/cli/doctor.ts` + `doctor-codes.ts` (new code, e.g. `I-CLOUD-002` informational)
- Test: extend `packages/vendo/src/cli/doctor.test.ts` patterns

- [ ] Failing tests: key + mcp + no public base URL → informational "hosted MCP broker activates when deployed to a public URL"; key + mcp + public URL → prints the tenant URL it WOULD/did compose. Restore honesty to the doctor-live line that Task 4 of the fix lane softened — it may now truthfully name the broker again ONCE this seam exists (`cli/doctor-live.ts:165` area; coordinate wording with what shipped in flowlet PR #739).
- [ ] Implement; commit.

### Task B4: flowlet gates + PR

- [ ] Full gate foreground: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`. Changeset added (`@vendoai/vendo` minor).
- [ ] One PR to flowlet main. Do NOT merge — checker first. Note in body: composition contract consumed is the frozen wire contract in this plan; console PR must DEPLOY before this releases on npm (merge order guard).

## Conductor-owned (not the workers): checker rounds per PR (Codex, no round cap, till clean) → simplify gate → merge order: vendo-web PR merges + deploys (incl. hand-applied broker migration + `railway up` per `services/broker/README.md:181-200`) → live E2E proof → flowlet PR merges. Live E2E (the demo): deploy a keyed Maple, watch `maple.mcp.vendo.run` come alive, connect a real MCP client through OAuth, execute a tool, show the audit row. Record it.

## Self-review notes (done)
- Spec coverage: decisions 1-3 ✓ (A4/A5/B2), architecture flow ✓ (A4+B1), components §1/§2/§3 ✓ (B2/A4-A5/A1-A3), slug call ✓ (A4), dev rule ✓ (B2), non-goals respected (no OAuth-surface changes anywhere), testing section ✓ (each task test-first), amendment ✓ (contract returns secret every ensure; A4 GET-secret path).
- No placeholders; types in B1 match the frozen contract; `EnsureTenantResult.federationSecret` non-optional per amendment.
- Two repos = two PRs = one plan: acceptable (workers are independent against a frozen contract; each PR is independently testable software).
