# Vendo quickstart

Install the default composition and run setup:

```bash
npm install @vendoai/vendo
npx vendo init
```

The `vendoai` package is a thin alias. The scoped package is the canonical
install. `vendo init` asks nothing on the happy path. It writes two code
files — an empty `vendo/registry.tsx` and the catch-all handler wired to
it — plus two package.json script hooks, extracts your tools and brand
theme into `.vendo/`, resolves a model key, and prints the one line that is
yours to paste: the `<VendoRoot components={registry}>` wrap in your
layout. When it detects your auth provider in package.json it asks once to
confirm the preset (consent-style, Enter accepts; `--yes` and
non-interactive runs accept it silently). It never edits code you wrote. Then start your dev server — the agent is live in your app —
and run `npx vendo doctor` to verify everything with one real model turn.

## Non-interactive runs (agents)

Every init question has a value-flag answer, so a coding agent never hangs
on a prompt: `--auth <preset>` (authJs, clerk, supabase, auth0, jwt, none)
answers the auth confirm and picker, `--framework <next|express>` overrides
detection, `--cloud-key <key>` or `--byo` answers the Cloud offer,
`--ai-polish` grants consent for the AI pass (tool judgment and theme-slot
filling, one consent for both), and `--theme slot=value` (repeatable)
overrides a theme slot value directly. When a decision has no flag and
no detected default — an undetectable framework — a non-interactive run
errors with the exact flag to pass instead of guessing or prompting.

## Model keys

The agent needs an LLM. `createVendo`'s `model` is optional: when you don't
pass one, the composed default resolves a real key from the environment, in
this order:

1. An explicit env key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `GOOGLE_GENERATIVE_AI_API_KEY` (install the matching `@ai-sdk/*@^3`
   provider). This same rung serves production.
2. `VENDO_API_KEY` — a Vendo Cloud dev key. When init finds no key, it offers
   `vendo cloud login`: it emails you a one-time code, prompts for it on
   stdin (the browser flow is the separate `vendo cloud device-login`
   command), then mints a metered dev-mode starter key and writes it to
   `.env.local` for you. You never paste a key.
   Model calls go through the Vendo Cloud model gateway (Anthropic models,
   served via the installed `@ai-sdk/anthropic`) and meter your dev-mode
   runs allowance.
3. Nothing available: chat fails honestly, with exact instructions in the
   server log.

Production deploys always need a real server-side key. To take full control
of the model (BYO-LLM), pass any ai-SDK model to `createVendo({ model })`.

Vendo Cloud is optional. When `VENDO_API_KEY` is set, init validates it and
states the plan and what it unlocks; when it is absent, init prints one calm
line and offers `vendo cloud login` only when a starter key would help.

To see every Vendo surface and state (streaming, approvals, slots, the
workspace page) against scripted data first — no model key, no wiring — run
`npx vendo playground`.

## AI polish (tool judgment and theme)

Static extraction gets the facts; a coding agent adds the judgment. The
deterministic exact pass always reads conventional CSS tokens into
`theme.json` first; whatever slots it can't read ride this same
consent-gated pass. During an interactive `vendo init`, when the `claude` CLI
is on PATH (or `@anthropic-ai/claude-agent-sdk` is resolvable) and a Claude
Code login or `ANTHROPIC_API_KEY` exists, init asks once for consent and lets
the agent read your codebase (read-only: Read/Glob/Grep; source goes to your
model provider under your own account). Nothing needs installing in your app
for this pass: no `@ai-sdk/anthropic`, no bundled SDK. It drafts
task-oriented tool descriptions, reviews risk grades, wakes statically
unclassifiable tools with reasoning, fills theme slots the exact pass
couldn't resolve, and writes the product brief.

The pass runs as a staged pipeline, not one shot: a cheap survey maps the
repo and groups tools into surfaces (`VENDO_EXTRACTION_SURVEY_MODEL` can
point it at a faster model), one focused pass drafts each surface, a
cross-check reviews the combined draft for consistency, the brief is
drafted from what the stages learned, and an optional theme stage runs
last, filling whatever the exact CSS read couldn't. Each stage writes its artifact to
`.vendo/data/extract/<stage>.json` (gitignored) for inspection, and failures
degrade per stage — a failed surface is skipped with a note instead of
aborting the run.

Everything it proposes passes deterministic guards before applying: only
extracted tool names are accepted, risk can be raised but never lowered,
waking a disabled tool requires reasoning plus an explicit grade, and human
decisions always win (existing `.vendo/overrides.json` fields and a
hand-written `brief.md` are never overwritten). The output lands in the
override channel, so `vendo sync` regeneration keeps it. Skipped silently in
non-interactive runs; re-run `vendo init` any time to add it.

### Bring your own coding agent

The extraction contract is portable: any coding agent already living in your
repo (Claude Code, Cursor, Codex) can do the reading instead. `npx vendo init
--agent` emits an `aiPolish` object in its read-only plan: the composed
`instructions`, the exact draft `draftSchema`, and the apply command. Let your
agent read the codebase against the instructions and write the draft JSON to a
file, then apply it:

```bash
npx vendo extract --apply draft.json
```

The apply step is non-interactive safe and runs the same deterministic guards
as the built-in pass, so delegation never becomes a second, weaker path into
`.vendo/`. It writes the same artifacts, re-syncs, and prints the same
summary. An unusable draft (unreadable file, schema mismatch) exits non-zero
with the reason; guard refusals (unknown tool names, risk downgrades,
unreasoned wakes) are printed per entry while the rest of the draft applies.
`--force` replaces a hand-edited brief, exactly like `vendo init --force`.

## The two files you own

A host's entire server wiring is two files: `vendo/registry.tsx`, which
declares the components generated views can use, and the composition — one
`createVendo` call with a model, an auth preset, and that registry. On
Next.js the composition lives inline in the catch-all route
`app/api/vendo/[...vendo]/route.ts`, which is exactly what `vendo init`
scaffolds.

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

### The catch-all route — the composition

```ts
// app/api/vendo/[...vendo]/route.ts — the `vendo init` scaffold, plus an
// explicit model pin (init itself writes no model line)
import { anthropic } from "@ai-sdk/anthropic";
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";
import { registry } from "@/vendo/registry";

const vendo = createVendo({
  model: anthropic("claude-sonnet-4-6"),
  auth: authJs(),
  catalog: registry,
  policy: {}, // .vendo/policy.json: destructive asks, reads run
});

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
```

The example pins an explicit provider. You can omit `model` entirely — the
composed default resolves a real key from the environment (see Model keys
above), so the first turn works before you have picked one; pass any AI SDK
model whenever you want full control.

`authJs()` is zero-argument in the standard case: it reads `AUTH_SECRET`
(mirroring Auth.js itself) and derives the principal's display name and email
from the session-token claims. `auth` is one preset that fills all three
identity seams `createVendo` needs — the request→principal resolver, the
away/MCP `actAs` seam, and the door's OAuth adapter — from one config key.
Presets exist for Auth.js, Clerk, Supabase, Auth0, and a generic JWT scheme;
see [actAs preset recipes](./act-as-presets.md) for the full list, the
`user` resolver for custom identity mapping, and the per-seam escape hatch for
hosts without a shipped preset.

`model` and `catalog` are the only other keys most hosts touch on day one.
Every key is optional — a bare `createVendo()` legitimately boots, with an
env-resolved model, anonymous ephemeral sessions, and PGlite persistence.
The `policy: {}` line activates the `.vendo/policy.json` file init wrote, so
the scaffolded default posture is: destructive tools ask, reads run. Remove
the `policy` key entirely and every call auto-runs (audited, with the
unconfigured-policy notice in shipped chrome). The default file is read
fail-soft: deleting `.vendo/policy.json` while keeping `policy: {}` also
auto-runs, silently and without the notice — keep the file in version
control; it is part of your security posture. Named presets replace the
file: `"cautious"` asks before write/destructive calls and runs reads,
`"readonly"` runs reads and blocks everything else, and `"autopilot"` runs
everything. Inline `{ rules }` and the explicit `{ file }` form cover
anything a preset doesn't.

`createVendo`'s real configuration surface:

```ts
import type { Principal, ActAs, ComponentCatalog, ComponentRegistry, SecretsProvider, Json, RunId } from "@vendoai/core";
import type { LanguageModel } from "ai";
import type { VendoStore } from "@vendoai/store";
import type { VendoAgent } from "@vendoai/agent";
import type { Connector, ActionsRegistry, ServerActionHandler } from "@vendoai/actions";
import type { VendoGuard, PolicyConfig, Judge } from "@vendoai/guard";
import type { AppsConfig, AppsRuntime, SandboxAdapter } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import type { ConnectionsService, HostAuthPreset, HostOAuthAdapter } from "@vendoai/vendo/server";

export function createVendo(config: {
  model?: LanguageModel;       // absent → env-resolved key (see Model keys above)
  paint?: AppsConfig["paint"]; // paint-lane knob for app generation (no-think model, or `disabled`)
  auth?: HostAuthPreset;       // one preset fills principal + actAs + oauth
  principal?: (req: Request) => Promise<Principal | null>; // escape hatch
  catalog?: ComponentCatalog | ComponentRegistry;           // registry.tsx, or the array form
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  connectors?: Connector[];
  connections?: ConnectionsService; // explicit connections adapter; always wins over defaults
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

Every key is optional: `model` resolves from the environment when absent (see
Model keys above), and with neither `auth` nor `principal` every session is
ephemeral and anonymous. `auth` and any of `principal`/`actAs`/`oauth` are
mutually exclusive — supplying both throws a validation error at compose
time. Pick the preset or hand-wire the three seams, never both.

Prefer a separate `vendo/server.ts` (exporting the same `createVendo`
result) when code outside the route needs the `vendo` object — `vendo.emit`
for host events, the MCP door's `.well-known` route, or tests. The route
then shrinks to a re-export:

```ts
import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
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

`components` accepts the same registry object the composition passes as
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

Every call passes through the guard. The scaffolded composition passes
`policy: {}`, which reads `.vendo/policy.json`: destructive tools ask, reads
run. A composition with no `policy` key at all auto-runs every call (audited),
and shipped chrome displays the unconfigured-policy notice.

## What works without more configuration

- PGlite persistence at `.vendo/data` (until `VENDO_API_KEY` is set — see
  below)
- tree-only apps, including host and generated components
- threads, approvals, grants, activity, and app lifecycle routes
- schedule, host-event, and external-trigger automation machinery

Server-shaped app requests ("email me a digest of unpaid invoices at 8am")
ride the automations engine by default — a steps or agentic automation on the
app document, created in seconds with no sandbox anywhere. A sandbox adapter
plus the experimental `apps: { experimentalMachines: true }` opt-in unlocks
machine-backed apps (custom server code in a box): see
[the machine model](./machine-model.md) for the three layers, the escalation
ladder, graduation, and the box contract. Machine provisioning also requires
`VENDO_BASE_URL`, since the box calls back to your deployment's public origin. `auth` (or its `actAs`
half, hand-wired) unlocks host API calls while the user is away. Connectors
add external tools. `VENDO_API_KEY` activates cloud-gated sharing, publishing,
org overlays, and pinning — and fills the adapter slots you left unset with
Cloud defaults:

- the sandbox slot becomes the hosted sandbox when you passed no adapter and
  no `E2B_API_KEY` is set;
- the store slot becomes the Cloud hosted store when you passed no `store` —
  threads, apps, records, grants, and audit then persist in Vendo Cloud
  instead of local PGlite. Pass `store: createStore(...)` to keep data local.

An explicitly passed adapter or BYO key always wins over both defaults.

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
`VENDO_API_KEY` when set (and shows what Cloud unlocks).

When nothing is listening on the dev port, `doctor` offers to start the dev
server for the probe (or pass `--yes` to start it non-interactively). `--json`
prints one machine-readable object — `checks`, `liveTurn`, `cloud`, and the
exit code — for scripts and agents. Every check carries a stable `id`; failing
and warning checks additionally carry a registry `error_code` (e.g.
`E-AUTH-001`) and a `fix_ref` URL into `https://vendo.run/agents/verify` with
the installed version as a query param, so an agent's remediation loop is:
doctor → read `fix_ref` → fix → repeat.

`sync` extracts the host API and remix baselines. In strict mode, breaking
extraction changes exit with code 2.

`sync` also writes `.vendo/semantics.json`: per-tool field semantics (cents
money, ISO/epoch dates, enum vocabularies with display labels, ids, percents)
inferred ONCE by sampling each zero-input read tool through the dev server,
plus a domain manifest (`has` / `hasNot`) derived from tool names on first
sync. The file is yours to edit — corrections and the manifest survive every
re-sync, and `overrides.json` `tools[name].semantics` wins over everything.
Generation treats it as fact: annotated response shapes, correct money/date
formatting by default, and honest disclaimers for domains you list under
`hasNot`. Empty tool descriptions also get generated "Use this to …" lines in
`tools.json` (override in `overrides.json`).

To make the deployed door discoverable through the official registry, follow
[Publish to the MCP registry](publish-mcp-registry.md).
