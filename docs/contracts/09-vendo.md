# @vendoai/vendo — the umbrella

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: glue. The default composition + re-exports; the only package allowed to depend on everything. `npm install @vendoai/vendo` + `npx vendo init` = the working agent; blocks stay à la carte for everyone else. `vendoai` stays published as a thin alias; bare `vendo` becomes the unscoped alias if npm frees it. ⚑ This package owns the `vendo` bin (init/doctor/sync/cloud) — no separate published CLI. <!-- amended 2026-07-14: `cloud` added — a 4th command (cli.ts, cli/cloud/ tree) landed post-freeze; docs-site/reference/cli.mdx already documents four. -->


## 1. Entry points

| Entry | Contents |
| --- | --- |
| `@vendoai/vendo` | root types re-exported from core (+ each block's primary types) |
| `@vendoai/vendo/server` | `createVendo` — the composition + handler |
| `@vendoai/vendo/react` | re-exports `@vendoai/ui` (+ `<VendoRoot>` = provider wired to defaults) |
| bin `vendo` | `init`, `doctor`, `sync`, `cloud` |

## 2. The composition

```ts
import type { Principal, ActAs, SecretsProvider, Json, RunId } from "@vendoai/core";
import type { LanguageModel } from "ai";                      // peerDependency (00 conventions)
import type { VendoStore } from "@vendoai/store";
import type { VendoAgent } from "@vendoai/agent";
import type { ActionsRegistry, Connector } from "@vendoai/actions";
import type { VendoGuard, PolicyConfig, Judge } from "@vendoai/guard";
import type { AppsRuntime, SandboxAdapter } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import type { HostOAuthAdapter } from "@vendoai/mcp";       // the door's identity + consent seam (10-mcp §3), re-exported from the umbrella root

export function createVendo(config: {
  model: LanguageModel;                       // the one required thing
  principal: (req: Request) => Promise<Principal | null>;   // host session → principal; null → ephemeral anonymous
  store?: VendoStore;                         // default: createStore() (PGlite, .vendo/data)
  sandbox?: SandboxAdapter;                   // e.g. e2bSandbox({ apiKey }); absent → rung 1 only
  connectors?: Connector[];
  actAs?: ActAs;
  policy?: PolicyConfig;
  judge?: Judge;                              // e.g. vendoAutoJudge({ model }) — one import, no shorthand union
  secrets?: SecretsProvider;                  // default envSecrets()
  telemetry?: boolean;                        // wires @vendoai/telemetry (out of campaign scope, "stays as-is") — the one consumer outside this set
  mcp?: boolean;                              // open the MCP door (10-mcp §1); off by default — opening it is a host decision
  oauth?: HostOAuthAdapter;                   // the door's identity + consent seam (10-mcp §3); REQUIRED when `mcp` is true — the door cannot mint principals without it
}): Vendo;
<!-- amended 2026-07-14: `mcp?`/`oauth?` added — MCP door landed (PR #139); original froze pre-door. Code: server.ts:56-75 (CreateVendoConfig.mcp/oauth), plus the runtime guard that throws when `mcp: true` without `oauth`. -->


export interface Vendo {
  handler: (req: Request) => Promise<Response>;   // fetch-style; mount at /api/vendo/[...]
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;   // the host-event seam, re-exposed
  // the composed blocks, for hosts that want to reach in:
  agent: VendoAgent; guard: VendoGuard; apps: AppsRuntime; automations: AutomationsEngine; actions: ActionsRegistry; store: VendoStore;
}
```

Wiring (normative): `actions.add(apps.agentTools())`; every `ToolRegistry` handed to agent, apps, and automations is `guard.bind(...)`ed here — blocks never see an unbound registry. `nextVendoHandler(vendo)` adapts the fetch handler to a Next.js route module; the handler shape itself is framework-agnostic (page: framework-agnostic, any JS runtime).

## 3. The wire (public contract — ui speaks exactly this)

Mounted under one base (default `/api/vendo`). Auth: every request passes through `principal(req)`; payload types are core types, JSON-encoded; streams are SSE.

| Route | Method | Body → Response |
| --- | --- | --- |
| `/threads` | POST | `{ threadId?, message }` → ai-SDK UI message stream (SSE) — one conversational turn; response includes `X-Vendo-Thread-Id: ThreadId` (the effective requested or server-minted id) |
| `/threads` · `/threads/:id` | GET · GET/DELETE | thread summaries · thread |
| `/approvals` | GET | pending `ApprovalRequest[]` |
| `/approvals/decide` | POST | `{ ids, decision }` → `{}` (batch-capable) |
| `/grants` · `/grants/:id` | GET · DELETE | grants · revoke |
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
| `/status` | GET | `{ posture, version, blocks: {...} }` (doctor's live probe) |
| `/mcp` (+ subpaths) | ALL | MCP door mount (only when `createVendo({ mcp: true, oauth })`); the door owns these paths and authenticates every request through `oauth.principal` — NOT a wire route |

<!-- amended 2026-07-14: MCP door landed (PR #139); original froze pre-door. The door mounts at `/api/vendo/mcp` (server.ts:33 `MCP_MOUNT`) and is handed its own paths BEFORE any wire machinery — ahead of the CSRF json-mutation gate — because it mints its own principals via `oauth.principal` and bypasses the wire's principal/CSRF machinery (server.ts:394-405). It also serves four origin-root discovery documents pre-auth (server.ts:158-169): `/.well-known/oauth-protected-resource/api/vendo/mcp`, `/.well-known/oauth-authorization-server/api/vendo/mcp` (RFC 9728/8414 path-inserted metadata for the mount), `/.well-known/mcp/server-card.json`, and `/.well-known/mcp-server-card` (SEP-2127 server card). Only these exact four are matched, not the whole `/.well-known/oauth-*` prefix, so a host serving its own OAuth/OIDC metadata at the same origin is not shadowed. -->
**Webhook verification (normative)**: `/webhooks/:source` never dispatches unverified deliveries. Each source registers a verification at wiring time: the connector's own signature scheme (e.g. Composio's signed headers), or — for self-minted subscriptions — the industry-standard signing scheme (Stripe/Svix/GitHub school): HMAC-SHA256 over `id.timestamp.rawBody` with the secret minted at enable, delivered as signature + timestamp + delivery-id headers, verified within a ±5-minute window. **The secret itself never travels in a URL** (URLs leak via logs and proxies). Deliveries are deduped by delivery id, so at-least-once retries never double-fire an automation. Verification failure → `401`, no principal resolution, no run, one audit event.

<!-- amended 2026-07-14: the following claim was true pre-door; the MCP door (PR #139) now serves OAuth/MCP well-known discovery documents pre-auth, ahead of the CSRF gate. Corrected below. -->
The unauthenticated surface of the wire proper is still exactly nothing: every route in the table above passes through `principal(req)`. When the door is open (`mcp: true`), the door adds its own pre-auth surface — the four origin-root discovery documents noted above — served ahead of the wire's principal/CSRF machinery by design (public OAuth/MCP discovery metadata carries no authority; the door authenticates the actual `/api/vendo/mcp` tool calls through `oauth.principal`, guard-bound identically to chat).

**Errors (normative)**: every non-2xx wire response is the one envelope the set already has (06 §4.1): `{ "error": { "code": VendoErrorCode, "message": string } }`, with the fixed status map `validation`→400, `not-found`→404, `blocked`→403, `conflict`→409, `cloud-required`→402, `sandbox-unavailable`/`not-implemented`→501.

**CSRF (normative)**: the wire is cookie-authenticated (`principal(req)` reads the host session), so the handler rejects state-changing requests whose `Content-Type` is not `application/json` (forcing a CORS preflight cross-origin) — the OWASP-recommended minimum for embedded surfaces where hosts relax `SameSite`. Exceptions, listed exhaustively: `/apps/import` (binary body) and `/webhooks/:source` / `/tick` (non-cookie auth above).

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
- **`vendo doctor`** — wiring checks + one live round-trip against `/status`; green = working agent; ends with ladder hints (the one config line that unlocks each remaining block).
- **`vendo sync`** — the build-step extraction, callable manually (04 §1).
- **`vendo cloud <command>`** — talk to the public Vendo Cloud API (auth/session, keys, members, services, reads); the paid line's CLI surface (§6). <!-- amended 2026-07-14: `cloud` command landed post-freeze (cli.ts, cli/cloud/ tree); original froze with only init/doctor/sync. -->

Exit codes: doctor `0` green / `1` broken wiring; sync `0` (fail-soft warns) / `2` with `--strict` on breaking changes.

## 6. Cloud enforcement

`VENDO_API_KEY` present → cloud-gated surfaces (share/publish/org/pinning) verify entitlements against Cloud and light up; absent → those methods throw `VendoError("cloud-required")`. Paid code lives in the private cloud repo; this repo stays pure Apache-2.0.
