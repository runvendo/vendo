# @vendoai/vendo — the umbrella

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: glue. The default composition + re-exports; the only package allowed to depend on everything. `npm install @vendoai/vendo` + `npx vendo init` = the working agent; blocks stay à la carte for everyone else. `vendoai` stays published as a thin alias; bare `vendo` becomes the unscoped alias if npm frees it. ⚑ This package owns the `vendo` bin (init/doctor/sync/cloud) — no separate published CLI. <!-- amended 2026-07-14: `cloud` added — a 4th command (cli.ts, cli/cloud/ tree) landed post-freeze; docs-site/reference/cli.mdx already documents four. -->


## 1. Entry points

| Entry | Contents |
| --- | --- |
| `@vendoai/vendo` | root types re-exported from core (+ each block's primary types) |
| `@vendoai/vendo/server` | `createVendo` — the composition + handler |
| `@vendoai/vendo/react` | re-exports `@vendoai/ui` (+ `<VendoRoot>` = provider wired to defaults) |
| bin `vendo` | `init`, `doctor`, `sync`, `refine`, `cloud` | <!-- amended 2026-07-15: `refine` added (ENG-250, §5) -->

## 2. The composition

```ts
import type { Principal, ActAs, SecretsProvider, Json, RunId, ComponentCatalog, ComponentRegistry } from "@vendoai/core";
import type { LanguageModel } from "ai";                      // peerDependency (00 conventions)
import type { VendoStore } from "@vendoai/store";
import type { VendoAgent } from "@vendoai/agent";
import type { ActionsRegistry, Connector } from "@vendoai/actions";
import type { VendoGuard, PolicyConfig, Judge } from "@vendoai/guard";
import type { AppsRuntime, SandboxAdapter } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import type { HostOAuthAdapter } from "@vendoai/mcp";       // the door's identity + consent seam (10-mcp §3), re-exported from the umbrella root

export function createVendo(config: {
  model?: LanguageModel;                      // optional since install-dx v1 (amended 2026-07-18): absent → env-resolving default (provider keys → Vendo Cloud gateway → honest failure); pass your own for BYO-LLM
  auth?: HostAuthPreset;                      // ONE host-identity preset filling principal + actAs + oauth (§2.1); mutually exclusive with all three — mixing throws VendoError("validation") at compose time
  principal?: (req: Request) => Promise<Principal | null>;   // per-seam escape hatch: host session → principal; null → ephemeral anonymous. Neither `auth` nor `principal` → anonymous ephemeral sessions only (the null path is the default resolver)
  store?: VendoStore;                         // default: createStore() (PGlite, .vendo/data)
  catalog?: ComponentCatalog | ComponentRegistry;   // host components (01 §14); registry object form: the server reads data fields only and MUST IGNORE each entry's `component` — normalized to ComponentCatalog before wiring apps (06 §1)
  sandbox?: SandboxAdapter;                   // e.g. e2bSandbox({ apiKey }); absent → rung 1 only
  connectors?: Connector[];
  actAs?: ActAs;                              // per-seam escape hatch (01 §13)
  policy?: PolicyConfig;
  judge?: Judge;                              // e.g. vendoAutoJudge({ model }) — one import, no shorthand union
  secrets?: SecretsProvider;                  // default envSecrets()
  telemetry?: boolean;                        // wires @vendoai/telemetry (out of campaign scope, "stays as-is") — the one consumer outside this set
  mcp?: boolean;                              // open the MCP door (10-mcp §1); off by default — opening it is a host decision
  oauth?: HostOAuthAdapter;                   // per-seam escape hatch — the door's identity + consent seam (10-mcp §3); `mcp: true` REQUIRES an adapter, from here or from `auth` — the door cannot mint principals without one
  sessions?: {                                // anonymous (ephemeral) session lifecycle (02 §4, kill-list B3)
    ttlMs?: number;                           // idle timeout; default 30 min; 0 disables TTL eviction
    sweepIntervalMs?: number;                 // amortized + timer sweep cadence; default 60 s
  };                                          // (internal `now` clock seam exists for tests only)
}): Vendo;
<!-- amended 2026-07-14: `mcp?`/`oauth?` added — MCP door landed (PR #139); original froze pre-door. Code: server.ts:56-75 (CreateVendoConfig.mcp/oauth), plus the runtime guard that throws when `mcp: true` without `oauth`. -->
<!-- amended 2026-07-16: `sessions?` added — wave-4 session lifecycle landed (PR #301, ENG-237). Code: server.ts CreateVendoConfig.sessions + validateSessionsConfig (invalid values throw VendoError("validation") at compose time). Defaults Yousef-approved 2026-07-16. -->
<!-- amended 2026-07-17: `sessions.maxSessions` retired — the overlay's LRU cap died with the overlay (kill-list §B3; 02-store §4 is now disk rows + TTL sweep, and disk growth is bounded by the sweep). -->
<!-- amended 2026-07-18: `auth?` + `catalog?` added, `principal` optional — server-wiring DX (docs/brainstorms/server-wiring-dx.md, decisions 1/2/6). `auth` with any of principal/actAs/oauth throws VendoError("validation") at compose time; neither `auth` nor `principal` boots with anonymous ephemeral sessions only (00 conventions "identity optional"; 02 §4). The lane's original "`model` stays the one required key" clause was superseded at merge (2026-07-18) by the install-dx v1 model-optional amendment above — both lanes landed the same day; model-optional (Yousef-approved, PRs #362/#363) wins. -->


export interface Vendo {
  handler: (req: Request) => Promise<Response>;   // fetch-style; mount at /api/vendo/[...]
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;   // the host-event seam, re-exposed
  // the composed blocks, for hosts that want to reach in:
  agent: VendoAgent; guard: VendoGuard; apps: AppsRuntime; automations: AutomationsEngine; actions: ActionsRegistry; store: VendoStore;
}
```

Wiring (normative): `actions.add(apps.agentTools())`; every `ToolRegistry` handed to agent, apps, and automations is `guard.bind(...)`ed here — blocks never see an unbound registry. `nextVendoHandler(vendo)` adapts the fetch handler to a Next.js route module; the handler shape itself is framework-agnostic (page: framework-agnostic, any JS runtime).

Session lifecycle wiring (normative, 02 §4 / kill-list B3): the umbrella touches the session on every ephemeral-principal request (`registerEphemeralSubject` — register == touch, awaited before the route runs) with its own session clock passed as `now` (wall time in production; the internal test-only seam noted above). Sweeps run both amortized on-request (any request arriving `sweepIntervalMs` after the last sweep triggers one — awaited BEFORE the request is handled, the evict-on-expiry ordering and the serverless-safe leg) and on an unref'd background timer every `sweepIntervalMs`, torn down with `store.close()`. Every swept subject cascades store-first into `agent.evictSubject` (03 §1): a concurrent request fails closed at the store rather than finding agent threads without store state. The overlay-era inflight bracket and `setSessionClock`/`setSessionCap` wiring are retired with the overlay.

## 2.1 Host-identity presets — `auth` (2026-07-18 amendment)

One identity story, three seams. A `HostAuthPreset` fills the request→Principal resolver, the away/MCP `actAs` seam, and the door's `HostOAuthAdapter` from one config key — the host expresses its identity once instead of three times (demo-bank's pre-amendment version was ~115 lines of glue deriving all three seams from the same two lookups).

```ts
export interface HostAuthPreset {
  principal: (req: Request) => Promise<Principal | null>;
  actAs?: ActAs;                    // absent → away/MCP execution cleanly unavailable, as ever (01 §13)
  oauth?: HostOAuthAdapter;         // absent → the door cannot open (`mcp: true` still requires an adapter, §2)
}

/** Named presets, shipped on the umbrella's server entry. Zero-argument in the standard
 *  case: each reads its own env (e.g. AUTH_SECRET — mirroring Auth.js itself) and derives
 *  the principal's `display` (name/email) from session-token claims. */
export function authJs(options?: HostAuthPresetOptions): HostAuthPreset;
export function clerk(options?: HostAuthPresetOptions): HostAuthPreset;
export function supabase(options?: HostAuthPresetOptions): HostAuthPreset;
export function auth0(options?: HostAuthPresetOptions): HostAuthPreset;
export function jwt(options?: HostAuthPresetOptions): HostAuthPreset;      // generic JWT

export interface HostAuthPresetOptions {
  user?: (subject: string, claims: Record<string, unknown>) => Promise<Pick<Principal, "display"> | null>;   // optional subject→user resolver for custom logic; null declines the session → ephemeral anonymous
}
```

`HostAuthPresetOptions` also accepts an optional `secret` (or system-equivalent — e.g. the away-token secret for clerk/auth0) override for the preset's env-read secret. <!-- amended 2026-07-18: additive widening, 2a spec review -->
The `user` resolver returns `{ display?, email? }` — `email` feeds actAs session claims only (a Principal carries no email). <!-- amended 2026-07-18: additive widening, 2a spec review -->
`jwt()` is not zero-argument like the vendor presets: a host-generic HS256 scheme has no vendor-owned env variable to read, so it requires `jwt({ secret })`. <!-- amended 2026-07-18: server-wiring DX migration, apps/demo-bank -->

Normative: supplying `auth` together with ANY of `principal`, `actAs`, or `oauth` throws `VendoError("validation")` at compose time — one preset or the per-seam trio, never mixed; the trio remains the escape hatch for hosts without a preset. The presets' actAs halves are `@vendoai/actions/presets`' shipped implementations for the same providers (04 §2.1; clerk/auth0 keep their away-token producer+verify split — the verify middleware is still host-mounted); the oauth half implements 10-mcp §3.

## 3. The wire (public contract — ui speaks exactly this)

Mounted under one base (default `/api/vendo`). Auth: every request passes through the composed principal resolver (`auth` preset or `principal`, §2.1; the anonymous default when neither is configured); payload types are core types, JSON-encoded; streams are SSE.

| Route | Method | Body → Response |
| --- | --- | --- |
| `/threads` | POST | `{ threadId?, message }` → ai-SDK UI message stream (SSE) — one conversational turn; response includes `X-Vendo-Thread-Id: ThreadId` (the effective requested or server-minted id) |
| `/threads` · `/threads/:id` | GET · GET/DELETE | thread summaries · thread |
| `/approvals` | GET | pending `ApprovalRequest[]`; an `?org=<id>` param always `cloud-required` (kill-list A5) |
| `/approvals/decide` | POST | `{ ids, decision }` → `{}` (batch-capable); a `body.org` always `cloud-required` (kill-list A5) |
| `/grants` · `/grants/:id` | GET · DELETE | grants · revoke; an `?org=<id>` param always `cloud-required` (kill-list A5) |
| `/apps` | GET · POST | list · `{ prompt }` → `AppDocument` |
| `/apps/:id` | GET · DELETE | app · delete |
| `/apps/:id/open` | GET | `OpenSurface` |
| `/apps/:id/call` | POST | `{ ref: "fn:<name>" \| "<tool>", args }` → `ToolOutcome` (tree actions + fn: calls — 06 §1 `call`) |
| `/apps/:id/edit` | POST | `{ instruction }` → `EditResult` |
| `/apps/:id/history` | GET · POST | versions · `{ op: "undo" }` |
| `/apps/:id/export` | GET | `.vendoapp` bytes |
| `/apps/import` | POST | bytes → `AppDocument` (fresh id minted) |
| `/apps/:id/fork` | POST | → `AppDocument` |
| `/automations` | GET | list |
| `/automations/:id/enable` · `/disable` | POST | `{ enabled, missing }` · `{}` |
| `/automations/:id/dry-run` | POST | `RunPlan` |
| `/runs` · `/runs/:id` | GET | run records |
| `/runs/:id/stop` | POST | `{}` |
| `/tick` | POST | scheduler tick (serverless cron target; requires `Authorization: Bearer <secret>` — what Vercel cron sends natively) |
| `/webhooks/:source` | POST | trigger ingress (Composio, host, plain) — verified, see below |
| `/activity` | GET | `AuditEvent[]` — `guard.audit.query({ principal })` self-scoped at this route |
| `/status` | GET | `{ posture, version, blocks: {...} }` (doctor's live probe); `blocks.connections: "byo" \| "cloud" \| false` (04 §3.1) reports per-block posture |
| `/orgs` (+ every `/orgs/*` subpath) | ALL | always `cloud-required` — orgs are a Vendo Cloud capability, not an OSS wire route (kill-list A5) |
| `/connections` | GET | the resolved principal's `ConnectorAccount[]` (04 §3) — subject is never caller-supplied |
| `/connections/initiate` | POST | `{ toolkit, connector?, callbackUrl? }` → `{ id, redirectUrl }` (the broker's OAuth URL); ephemeral and synthetic (`webhook:`/`vendo:`) subjects refused |
| `/connections/:id` | GET · DELETE | `?connector=` — poll status (404 = not this subject's account, no oracle) · disconnect |
| `/sync/impact` | POST | `{ tools: string[] }` (≤200) → `{ impact: ToolImpact[] }` — blast radius per tool (apps, automations, grants); **dev-only**: production → `blocked` (04 §1) |
| `/doctor/present` · `/doctor/act-as` | POST | doctor's live probes (04 §4): present credentials actually reach the host API · actAs mint+verify round-trips (each with a `GET …/echo` loopback route) |
| `/mcp` (+ subpaths) | ALL | MCP door mount (only when `mcp: true` with an oauth adapter — the `oauth` key or the `auth` preset's oauth half, §2.1); the door owns these paths and authenticates every request through the adapter's `principal` — NOT a wire route |

<!-- amended 2026-07-14: MCP door landed (PR #139); original froze pre-door. The door mounts at `/api/vendo/mcp` (server.ts:33 `MCP_MOUNT`) and is handed its own paths BEFORE any wire machinery — ahead of the CSRF json-mutation gate — because it mints its own principals via `oauth.principal` and bypasses the wire's principal/CSRF machinery (server.ts:394-405). It also serves four origin-root discovery documents pre-auth (server.ts:158-169): `/.well-known/oauth-protected-resource/api/vendo/mcp`, `/.well-known/oauth-authorization-server/api/vendo/mcp` (RFC 9728/8414 path-inserted metadata for the mount), `/.well-known/mcp/server-card.json`, and `/.well-known/mcp-server-card` (SEP-2127 server card). Only these exact four are matched, not the whole `/.well-known/oauth-*` prefix, so a host serving its own OAuth/OIDC metadata at the same origin is not shadowed. -->
**Webhook verification (normative)**: `/webhooks/:source` never dispatches unverified deliveries. Each source registers a verification at wiring time: the connector's own signature scheme (e.g. Composio's signed headers), or — for self-minted subscriptions — the industry-standard signing scheme (Stripe/Svix/GitHub school): HMAC-SHA256 over `id.timestamp.rawBody` with the secret minted at enable, delivered as signature + timestamp + delivery-id headers, verified within a ±5-minute window. **The secret itself never travels in a URL** (URLs leak via logs and proxies). Deliveries are deduped by delivery id, so at-least-once retries never double-fire an automation. Verification failure → `401`, no principal resolution, no run, one audit event.

<!-- amended 2026-07-14: the following claim was true pre-door; the MCP door (PR #139) now serves OAuth/MCP well-known discovery documents pre-auth, ahead of the CSRF gate. Corrected below. -->
The unauthenticated surface of the wire proper is still exactly nothing: every route in the table above passes through the composed principal resolver. When the door is open (`mcp: true`), the door adds its own pre-auth surface — the four origin-root discovery documents noted above — served ahead of the wire's principal/CSRF machinery by design (public OAuth/MCP discovery metadata carries no authority; the door authenticates the actual `/api/vendo/mcp` tool calls through `oauth.principal`, guard-bound identically to chat).

**Errors (normative)**: every non-2xx wire response is the one envelope the set already has (06 §4.1): `{ "error": { "code": VendoErrorCode, "message": string } }`, with the fixed status map `validation`→400, `not-found`→404, `blocked`→403, `conflict`→409, `cloud-required`→402, `sandbox-unavailable`/`not-implemented`→501.

**CSRF (normative)**: the wire is cookie-authenticated (the principal resolver reads the host session), so the handler rejects state-changing requests whose `Content-Type` is not `application/json` (forcing a CORS preflight cross-origin) — the OWASP-recommended minimum for embedded surfaces where hosts relax `SameSite`. Exceptions, listed exhaustively: `/apps/import` (binary body) and `/webhooks/:source` / `/tick` (non-cookie auth above).

Rung-4 app UI is **not** proxied through the wire: `OpenSurface.kind === "http"` carries the sandbox provider's URL directly; the iframe talks to the machine, the machine talks back only through `VENDO_PROXY_URL` (06 §4.4).

## 4. `.vendo/` directory (the host-side contract, complete)

| Path | Written by | Format |
| --- | --- | --- |
| `tools.json` | sync | `vendo/tools@1` (04) |
| `overrides.json` | init interview / human | `vendo/overrides@1` (04) |
| `policy.json` | init / human | `vendo/policy@1` (05) |
| `remixable/<slot>.json` | sync | `PinBaseline` (06 §8) |
| `brief.md` | init | product brief for the system prompt (03 §3) |
| `design-rules.md` | host, optional | generation-time design rules (06 §5) |
| `theme.json` | init extraction | `VendoTheme` |
| `data/` | store | PGlite files (gitignored; init writes the ignore) |

## 5. The bin (DX, per the locked DX design)

- **`vendo init`** — interactive wizard: scans the app (deterministic + AI riding the dev's existing Claude Code / Codex / API key), interviews with recommendations (risk labels, theme, remix candidates), writes the two wiring snippets (handler route + `<VendoRoot>`) — every code change permission-gated with the diff shown; answers land in `overrides.json`, respected forever. `--agent` mode: emits the plan, writes nothing, asks ≤3 plain-language questions (vibe-coder persona; `install.md` is the canonical staged playbook it follows).
- **`vendo doctor`** — wiring checks + one live round-trip against `/status`; green = working agent; ends with ladder hints (the one config line that unlocks each remaining block). Live probes (ENG-260): `POST /doctor/present` proves present credentials reach the host API (fail advises `VENDO_BASE_URL`); `POST /doctor/act-as` proves the actAs mint+verify round-trip (not configured → warn, not fail).
- **`vendo sync`** — the build-step extraction, callable manually (04 §1). Queries `/sync/impact` when the dev server is reachable and prints per-tool blast radius; `--report` pushes the report to the Cloud console (requires `VENDO_API_KEY` or `--key`; push failure warns, never fails the build) (ENG-261).
- **`vendo cloud <command>`** — talk to the public Vendo Cloud API (auth/session, keys, members, services, reads); the paid line's CLI surface (§6). <!-- amended 2026-07-14: `cloud` command landed post-freeze (cli.ts, cli/cloud/ tree); original froze with only init/doctor/sync. -->
- **`vendo refine`** — the refine engine's CLI surface (04 §1/§6): one BYO-model pass over the extraction output, host source, the miss feed, and a dev interview proposes compound capabilities + briefs (`capabilities.json`), risk/curation/description corrections (`overrides.json`), and `brief.md` updates — probed against the running dev app (doctor's `/status` machinery; write-risk steps never executed), every file presented as a diff and applied only on approval. Also offered once at the end of `vendo init` (one engine, two surfaces). <!-- amended 2026-07-15: `refine` command landed (cli.ts, cli/refine.ts, refine.ts) per the approved extraction design (spec §3, ENG-250); extraction stays a build step — refine is a command by design (04 §1). -->

Exit codes: doctor `0` green / `1` broken wiring; sync `0` (fail-soft warns) / with `--strict`: `2` on breaking changes, `3` when a breaking tool also has nonzero blast radius (impact-unknown stays `2`). `vendo init` also writes `VENDO_BASE_URL` into `.env`/`.env.example` (04 §4) and scaffolds the `predev` (`vendo sync`) / `prebuild` (`vendo sync --strict`) hooks into the host package.json — permission-prompted, like route wiring (ENG-260/261).

## 6. Cloud enforcement

`VENDO_API_KEY` present → cloud-gated surfaces (share/publish/pinning) verify entitlements against Cloud and light up; absent → those methods throw `VendoError("cloud-required")`. Paid code lives in the private cloud repo; this repo stays pure Apache-2.0. Orgs are cloud-required unconditionally — no key or entitlement lights them up in this repo (kill-list A5, amended below).

## Amendments

### 2026-07-15 — Block-actions wave (ENG-260/261/262, parent ENG-264)

- **Changed:** §3 adds the per-principal connection routes (`/connections`, `/connections/initiate`, `/connections/:id`), the dev-only `/sync/impact` blast-radius endpoint, the doctor probe routes, and the `blocks.connections` posture in `/status`.
- **Changed:** §5 documents doctor's live probes, sync's impact query + `--report`, the 2/3 strict exit codes, and init writing `VENDO_BASE_URL` + predev/prebuild hooks.
- **Why:** The silent-trap fixes (ENG-260), sync completion (ENG-261), and connected accounts (ENG-262) all landed umbrella surface; the frozen wire table predated them. All additive.
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

### 2026-07-15 — Org wire surface (ENG-263, parent ENG-264 follow-up)

- **Changed:** §3 adds the `/orgs` routes (list/create, get-one, members add/set-role/remove, app transfer), `?org=<id>` scoping on `/approvals` and `/grants`, and the `blocks.orgs` posture in `/status`.
- **Why:** ENG-263 shipped the org wire surface (PR #277); the coordinated contracts amendment (#269) landed before these route rows were written. This completes the 09-vendo half of the block-actions amendment.
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

### 2026-07-16 — Ephemeral session policy knob and sweep wiring (ENG-237, wave 4)

- **Changed:** §2 config adds `sessions?: { ttlMs?, sweepIntervalMs?, maxSessions? }` (plus the internal test-only `now` seam), validated at compose time; defaults 30 min / 60 s / 10 000, `ttlMs: 0` disables TTL eviction (cap-only).
- **Changed:** §2 wiring adds the normative lifecycle paragraph: touch-on-request, inflight bracket held through streamed bodies, amortized on-request + unref'd timer sweeps (timer torn down with `store.close()`), store-first cascade into `agent.evictSubject`, and the `setSessionClock`/`setSessionCap` routing that keeps store-internal touches on the umbrella's clock and cap.
- **Why:** Wave 4 (PR #301) shipped the umbrella's session policy surface and the cross-block eviction cascade; the umbrella is the only component that sees both store and agent, so the cascade ordering belongs in the composition contract.
- **Approved by:** Yousef, 2026-07-16 (inventory: `docs/superpowers/specs/2026-07-16-wave4-contract-amendment-inventory.md`).

### 2026-07-17 — Orgs server surface removed, `cloud-required` seam kept

- **Changed:** §3's `/orgs` route family (list/create, get-one, members add/set-role/remove, app transfer) is removed; the entire path prefix now always answers `cloud-required`, unconditionally — not key-gated, not entitlement-gated. `?org=<id>` on `/approvals` and `/grants` gets the same unconditional `cloud-required` instead of admin-context scoping. `blocks.orgs` is removed from `/status`. §6's cloud-gated surface list drops `org` (share/publish/pinning remain entitlement-gated; orgs are never OSS-reachable at all).
- **Why:** simplify-v2 kill-list A5 — the org wire surface (§3, ENG-263) was implemented against the host's local store, contradicting the 2026-07-16 data-residency decision (Cloud enabled = data stored with Vendo). Orgs move to Vendo Cloud entirely; this repo keeps only the posture seam so a caller gets a clear error instead of a 404.
- **Authorized by:** the Yousef-approved simplify-v2 kill-list (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md`, §A5).

### 2026-07-17 — Session wiring on the disk model; `sessions.maxSessions` retired (kill-list §B3)

- **Changed:** §2's session-lifecycle wiring paragraph is rewritten to 02-store §4's disk model: the umbrella still touches on every ephemeral-principal request and runs the amortized + timer sweeps with the store-first `agent.evictSubject` cascade, but registration and the sweep are now awaited async store calls carrying the umbrella's clock as `now`; the inflight request bracket and the `setSessionClock`/`setSessionCap` wiring are retired with the overlay.
- **Changed:** `sessions.maxSessions` is removed from `createVendo`'s config — it existed to bound the overlay's process memory; anonymous data now lives on disk and is bounded by the TTL sweep.
- **Why:** kill-list §B3 replaced the store's in-memory ephemeral overlay with ordinary disk rows plus a `vendo_sessions` TTL sweep (02-store §4, same-date amendment); the umbrella wiring follows the store half's new seams.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §B3).

### 2026-07-18 — Server-wiring DX: unified `auth` key, optional identity, registry catalog

- **Changed:** §2 config adds `auth?: HostAuthPreset` — one host-identity preset `{ principal, actAs, oauth }` fills the request→Principal resolver, the away/MCP actAs seam, and the door's `HostOAuthAdapter` from one identity story (§2.1). Named presets (`authJs`, `clerk`, `supabase`, `auth0`, `jwt`) ship on the umbrella's server entry, zero-argument in the standard case (they read their own env, e.g. `AUTH_SECRET`, and derive `display` from session-token claims; an optional subject→user resolver covers custom logic). Supplying `auth` together with ANY of `principal`/`actAs`/`oauth` throws `VendoError("validation")` at compose time; the trio survives as the per-seam escape hatch.
- **Changed:** identity becomes optional overall: `principal` is no longer required, and a config with neither `auth` nor `principal` boots with anonymous ephemeral sessions only — the existing null-principal path is the default resolver (00 conventions "identity optional"; 02 §4). `model` stays the one required key.
- **Changed:** §2 config records `catalog?: ComponentCatalog | ComponentRegistry` — the name-keyed registry form (01 §14, same-date amendment) is accepted alongside the array form; the server reads only the data fields and MUST IGNORE each entry's `component` reference.
- **Changed:** §3's auth line, the `/mcp` row, and the pre-auth/CSRF paragraphs read "the composed principal resolver"; the door mounts when `mcp: true` has an oauth adapter from either channel (10-mcp §1 cross-reference updated in step).
- **Why:** the server-wiring DX brainstorm (decisions 1, 2, 6): demo-bank derived all three identity seams from the same two lookups (~115 lines of glue for one identity story); bare `createVendo()` legitimately boots; `model` + `auth` is the real quickstart rung.
- **Approved by:** Yousef, 2026-07-18 (server-wiring DX brainstorm, `docs/brainstorms/server-wiring-dx.md`, converged).
