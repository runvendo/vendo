# Vendo quickstart

Install the default composition and run the setup interview:

```bash
npm install @vendoai/vendo
npx vendo init
```

The `vendoai` package is a thin alias. The scoped package is the canonical
install. `vendo init` proposes two host changes: a catch-all handler and a
`<VendoRoot>` wrapper. It shows each diff before writing it.

## Dev-mode model ladder

`vendo init` resolves a model credential for development, in this order:

1. An explicit env key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `GOOGLE_GENERATIVE_AI_API_KEY` (install the matching `@ai-sdk/*@^3`
   provider). Explicit beats implicit; this rung also serves production.
2. Your authed Claude Code CLI session. Dev only, used after you consent in
   the wizard; needs `@anthropic-ai/claude-agent-sdk` in the app (init offers
   the install).
3. Your authed Codex CLI session. Dev only, used after you consent.
4. A Vendo Cloud starter allowance. When no local credential is found, init
   offers `vendo cloud login`; after login it mints a metered dev-mode key and
   writes `VENDO_API_KEY` to `.env.local` for you. You never paste a key.
5. Nothing available: chat fails honestly, with exact instructions in the
   server log.

The wizard states what it found. Consent for session rungs is recorded per
machine in `.vendo/data/dev-credential.json` (gitignored);
`VENDO_DEV_ALLOW_SESSIONS=1` is the non-interactive equivalent. Session rungs
are refused outright when `NODE_ENV` is `production`: production deploys
always need a real server-side key.

On session rungs the CLI harness supplies the model while Vendo keeps owning
tool execution and consent, so approvals, grants, and audit behave exactly as
with a key. The scaffolded `lib/ai.ts` exports `devModel()`, which resolves
this ladder at runtime; replace it with any ai-SDK model to take full control.

Init ends in the product: with your consent it starts the dev server, opens
the app in your browser, and seeds a first agent turn. The seed adapts to what
setup found: extracted tools get a live tool demo, a theme-only app gets an
on-brand UI generation, a blank app gets a tour.

Vendo Cloud is optional. When `VENDO_API_KEY` is set, init validates it and
states the plan and what it unlocks; when it is absent, init prints one calm
line and, if a starter key would help the ladder, offers `vendo cloud login`.

## The two files you own

A host's entire server wiring is two files: `vendo/registry.tsx`, which
declares the components generated views can use, and `vendo/server.ts`, which
calls `createVendo` with a model, an auth preset, and that registry.

### `vendo/registry.tsx` — the component registry

One object, keyed by component name. Each entry holds the real component
reference, a description the model reads, and an optional zod props schema.
The same object serves both sides: `createVendo` reads the registry as
`catalog` and uses only the data fields; `<VendoRoot>` reads it as `components`
and uses only the component references. There is no second map to keep in
sync.

```tsx
import type { ComponentRegistry } from "@vendoai/core";
import { z } from "zod";
import { SpendingDonut } from "@/components/charts/spending-donut";

export const registry = {
  SpendingDonut: {
    component: SpendingDonut,
    description: "Spending by category. Use for where-did-my-money-go requests.",
    props: z.object({
      slices: z.array(z.object({ category: z.string(), amount: z.number() })),
    }),
    examples: ['{"slices":[{"category":"dining","amount":342.18}]}'],
  },
} satisfies ComponentRegistry;
```

The props schema is optional — a schema-less entry is legal and renders as a
description-only prompt entry the model infers props for. When a schema is
present, the model-facing JSON Schema is derived from it internally; you never
hand-write one.

### `vendo/server.ts` — the composition

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { authJs, createVendo } from "@vendoai/vendo/server";
import { registry } from "./registry";

export const vendo = createVendo({
  model: anthropic("claude-sonnet-4-6"),
  auth: authJs(),
  catalog: registry,
});
```

`authJs()` is zero-argument in the standard case: it reads `AUTH_SECRET`
(mirroring Auth.js itself) and derives the principal's display name and email
from the session-token claims. `auth` is one preset that fills all three
identity seams `createVendo` needs — the request→principal resolver, the
away/MCP `actAs` seam, and the door's OAuth adapter — from one config key.
Presets exist for Auth.js, Clerk, Supabase, Auth0, and a generic JWT scheme;
see [actAs preset recipes](./act-as-presets.md) for the full list, the
`user` resolver for custom identity mapping, and the per-seam escape hatch for
hosts without a shipped preset.

`model` and `catalog` are the only other keys most hosts need on day one.
Every key is optional except `model` — `createVendo()` with just a model
legitimately boots, with anonymous ephemeral sessions and PGlite persistence.
Add a named `policy` preset once you want a guard posture instead of the
unconfigured-policy default: `"cautious"` asks before write/destructive calls
and runs reads, `"readonly"` runs reads and blocks everything else, and
`"autopilot"` runs everything. `.vendo/policy.json` (the `{ file }` form) and
inline `{ rules }` stay available for anything a preset doesn't cover.

`createVendo`'s real configuration surface:

```ts
import type { Principal, ActAs, ComponentCatalog, ComponentRegistry, SecretsProvider, Json, RunId } from "@vendoai/core";
import type { LanguageModel } from "ai";
import type { VendoStore } from "@vendoai/store";
import type { VendoAgent } from "@vendoai/agent";
import type { Connector, ActionsRegistry, ServerActionHandler } from "@vendoai/actions";
import type { VendoGuard, PolicyConfig, Judge } from "@vendoai/guard";
import type { AppsRuntime, SandboxAdapter } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import type { HostAuthPreset, HostOAuthAdapter } from "@vendoai/vendo/server";

export function createVendo(config: {
  model: LanguageModel;
  auth?: HostAuthPreset;       // one preset fills principal + actAs + oauth
  principal?: (req: Request) => Promise<Principal | null>; // escape hatch
  catalog?: ComponentCatalog | ComponentRegistry;           // registry.tsx, or the array form
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  connectors?: Connector[];
  actAs?: ActAs;                // escape hatch
  policy?: PolicyConfig;        // "cautious" | "readonly" | "autopilot" | { file } | { rules }
  judge?: Judge;
  secrets?: SecretsProvider;
  telemetry?: boolean;
  mcp?: boolean | { baseUrl?: string; remoteAs?: object; federation?: object };
  oauth?: HostOAuthAdapter;     // escape hatch; required when `mcp` is true and `auth` is absent
  serverActions?: Record<string, ServerActionHandler>; // generated by `vendo sync`
  agent?: { toolOutputCap?: number; maxOutputTokens?: number; historyWindow?: number; maxInitialTools?: number; maxSteps?: number };
  sessions?: { ttlMs?: number; sweepIntervalMs?: number };
  development?: boolean | { root?: string; out?: string }; // dev-only source capture
}): Vendo;

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent; guard: VendoGuard; apps: AppsRuntime; automations: AutomationsEngine; actions: ActionsRegistry; connections: ConnectionsService; store: VendoStore;
}
```

`auth` and any of `principal`/`actAs`/`oauth` are mutually exclusive —
supplying both throws a validation error at compose time. Pick the preset or
hand-wire the three seams, never both.

```ts
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";

export const { GET, POST, DELETE } = nextVendoHandler(vendo);
```

Mount the route at `/api/vendo/[...]`. The fetch handler itself is
framework-agnostic.

## Add the React root

```tsx
import { VendoRoot } from "@vendoai/vendo/react";
import { registry } from "@/vendo/registry";

export function Root({ children }: { children: React.ReactNode }) {
  return <VendoRoot components={registry}>{children}</VendoRoot>;
}
```

`components` accepts the same registry object `server.ts` passes as
`catalog` — it reads only the component references and ignores the data
fields. Use the headless hooks from `@vendoai/ui`, or add a shipped surface
from `@vendoai/ui/chrome`. `<VendoThread />`, `<VendoOverlay />`,
`<VendoPage />`, and `<VendoPalette />` all speak to the same wire.

## First turn

Open the mounted conversation surface and send a request such as “Build a view
of my overdue invoices.” The browser posts one turn to `/threads`. The response
is an AI SDK UI message stream. Any generated app surface arrives in a
`data-vendo-view` part and any approval metadata in a `data-vendo-approval`
part.

Present tool calls forward the inbound request's cookie and authorization
headers only when the wire trusts its own origin. In development, it learns
and trusts that origin automatically from the first request — no
configuration needed. In every other environment (including `NODE_ENV=test`),
the learned origin stays untrusted by default: a spoofed `Host` header can
never turn it into a credential-exfiltration target. Production deployments
must set `VENDO_BASE_URL` to the host's public origin; without it, a
present-mode host tool call that needs to forward credentials fails loud
instead of running unauthenticated, and `vendo doctor` reports the missing
var as a failing check.

```bash
VENDO_BASE_URL=https://app.example.com
```

Every call passes through the guard. With no policy or judge, calls auto-run
and are audited, and shipped chrome displays the unconfigured-policy notice.

## What works without more configuration

- PGlite persistence at `.vendo/data`
- tree-only apps, including host and generated components
- threads, approvals, grants, activity, and app lifecycle routes
- schedule, host-event, and external-trigger automation machinery

A sandbox adapter unlocks server-backed app rungs. `auth` (or its `actAs`
half, hand-wired) unlocks host API calls while the user is away. Connectors
add external tools. `VENDO_API_KEY` activates cloud-gated sharing, publishing,
org overlays, and pinning.

Use the [actAs preset recipes](./act-as-presets.md) to wire Auth.js, Supabase
Auth, Clerk, Auth0, or a host-owned generic JWT without changing the
`AuthMaterial` contract.

Away execution cannot create its own authority: it requires an app-bound
automation grant captured while that user was present. Without that prior
grant, the run parks for approval before `actAs` is called.

## Serve your product to MCP clients (the door)

Outside agents — Claude, ChatGPT, Cursor, and any MCP client — can connect to
your product through the MCP door: one flag (`mcp: true`) plus the same
`auth`/`oauth` seam you already wired. It is **experimental** and stays out of
this quickstart's main path until the attended live client matrix
(Claude/ChatGPT/Cursor) is demonstrably green. See [the MCP door
guide](../docs-site/capabilities/mcp.mdx) for the full setup, the discovery
route, and the graduation criterion.

## Check the install

```bash
npx vendo doctor
npx vendo doctor --json
npx vendo sync
```

`doctor` checks wiring, makes a live `/status` probe, verifies that present
credentials reach the host API, and exercises `actAs` minting through the
host's verifier when configured. It then runs one real model turn through the
same wired route your app serves and prints the reply: exit 0 means a user
would have gotten an answer, nonzero means the turn failed. It also validates
`VENDO_API_KEY` when set (and shows what Cloud unlocks), and warns when the
installed `codex` CLI drifts off the tested app-server protocol line.

When nothing is listening on the dev port, `doctor` offers to start the dev
server for the probe (or pass `--yes` to start it non-interactively). `--json`
prints one machine-readable object — `checks`, `liveTurn`, `cloud`, `codex`,
and the exit code — for scripts and agents.

`sync` extracts the host API and remix baselines. In strict mode, breaking
extraction changes exit with code 2.

To make the deployed door discoverable through the official registry, follow
[Publish to the MCP registry](publish-mcp-registry.md).
