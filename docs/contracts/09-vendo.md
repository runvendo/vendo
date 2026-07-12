# @vendoai/vendo — the umbrella

Status: DRAFT (wave 2). One job: glue. The default composition + re-exports; the only package allowed to depend on everything. `npm install @vendoai/vendo` + `npx vendo init` = the working agent; blocks stay à la carte for everyone else. `vendoai` stays published as a thin alias; bare `vendo` becomes the unscoped alias if npm frees it. ⚑ This package owns the `vendo` bin (init/doctor/sync) — no separate published CLI.

## 1. Entry points

| Entry | Contents |
| --- | --- |
| `@vendoai/vendo` | root types re-exported from core (+ each block's primary types) |
| `@vendoai/vendo/server` | `createVendo` — the composition + handler |
| `@vendoai/vendo/react` | re-exports `@vendoai/ui` (+ `<VendoRoot>` = provider wired to defaults) |
| bin `vendo` | `init`, `doctor`, `sync` |

## 2. The composition

```ts
export function createVendo(config: {
  model: LanguageModel;                       // the one required thing
  principal: (req: Request) => Promise<Principal | null>;   // host session → principal; null → ephemeral anonymous
  store?: VendoStore;                         // default: createStore() (PGlite, .vendo/data)
  sandbox?: SandboxAdapter;                   // e.g. e2bSandbox({ apiKey }); absent → rung 1 only
  connectors?: Connector[];
  actAs?: ActAs;
  policy?: PolicyConfig;
  judge?: Judge | { model: LanguageModel };   // shorthand builds vendoAutoJudge
  secrets?: SecretsProvider;                  // default envSecrets()
  telemetry?: boolean;
}): Vendo;

export interface Vendo {
  handler: (req: Request) => Promise<Response>;   // fetch-style; mount at /api/vendo/[...]
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;   // the host-event seam, re-exposed
  // the composed blocks, for hosts that want to reach in:
  agent: VendoAgent; guard: VendoGuard; apps: AppsRuntime; automations: AutomationsEngine; actions: ActionsRegistry; store: VendoStore;
}
```

Wiring (normative): `actions.add(apps.agentTools())`; every `ToolSet` handed to agent, apps, and automations is `guard.bind(...)`ed here — blocks never see an unbound registry. `nextVendoHandler(vendo)` adapts the fetch handler to a Next.js route module; the handler shape itself is framework-agnostic (page: framework-agnostic, any JS runtime).

## 3. The wire (public contract — ui speaks exactly this)

Mounted under one base (default `/api/vendo`). Auth: every request passes through `principal(req)`; payload types are core types, JSON-encoded; streams are SSE.

| Route | Method | Body → Response |
| --- | --- | --- |
| `/thread` | POST | `{ threadId?, message }` → ai-SDK UI message stream (SSE) |
| `/threads` · `/threads/:id` | GET · GET/DELETE | thread summaries · thread |
| `/approvals` | GET | pending `ApprovalRequest[]` |
| `/approvals/decide` | POST | `{ ids, decision }` → `{}` (batch-capable) |
| `/grants` · `/grants/:id` | GET · DELETE | grants · revoke |
| `/apps` | GET · POST | list · `{ prompt }` → `{ install, app }` |
| `/apps/:install` | GET · DELETE | app · remove |
| `/apps/:install/open` | GET | `OpenSurface` |
| `/apps/:install/call` | POST | `{ ref: "fn:<name>" \| "<tool>", args }` → `ToolOutcome` (tree actions + fn: calls — 06 §1 `call`) |
| `/apps/:install/queries` | POST | `{}` → refreshed data model (06 §1 `runQueries`) |
| `/apps/:install/edit` | POST | `{ instruction }` → `EditResult` |
| `/apps/:install/history` | GET · POST | versions · `{ op: "undo" }` |
| `/apps/:install/export` | GET | `.vendoapp` bytes |
| `/apps/import` | POST | bytes → `{ install }` |
| `/apps/:install/fork` | POST | → `{ install }` |
| `/automations` | GET | list |
| `/automations/:install/enable` · `/disable` | POST | `{ enabled, missing }` · `{}` |
| `/automations/:install/dry-run` | POST | `RunPlan` |
| `/runs` · `/runs/:id` | GET | run records |
| `/runs/:id/stop` | POST | `{}` |
| `/tick` | POST | scheduler tick (serverless cron target; requires shared-secret header `x-vendo-tick-key`) |
| `/webhooks/:source` | POST | trigger ingress (Composio, host, plain) |
| `/activity` | GET | `AuditEvent[]` (self-scoped) |
| `/status` | GET | `{ posture, version, blocks: {...} }` (doctor's live probe) |

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

Exit codes: doctor `0` green / `1` broken wiring; sync `0` (fail-soft warns) / `2` with `--strict` on breaking changes.

## 6. Cloud enforcement

`VENDO_API_KEY` present → cloud-gated surfaces (share/publish/org/pinning) verify entitlements against Cloud and light up; absent → those methods throw `VendoError("cloud-required")`. Paid code lives in the private cloud repo; this repo stays pure Apache-2.0.
