# Vendo quickstart

## Install and init

```bash
npm install @vendoai/vendo
npx vendo init
```

The `vendoai` package is a thin alias. The scoped package is the canonical
install. `vendo init` runs no interview: there are no keys to paste and no
per-diff approvals. An interactive run does stop for a few decisions, all of
them Enter-to-accept or y/n:

- the detected auth preset;
- the Vendo Cloud starter-key offer, only when no provider key is set;
- consent for the AI polish pass, naming the provider your source goes to;
- one aggregated **loosening review** — if the polish pass proposes waking a
  disabled tool or lowering a risk grade, init shows the diff and asks once
  before applying any of it;
- a `zod` bump, when your pin is below 3.25;
- a closing "star the repo?".

One question is not y/n: when the extractor is unsure of a theme slot it prints
what it found and takes a replacement **value** (a hex colour, a font stack) —
Enter keeps the extracted one.

`--yes` and non-interactive runs answer every one of them without stopping.
Loosenings are the one decision that has no unattended default: risk is never
lowered without a human, so they are held as pending and printed with the
command to review them (`vendo sync --review`), never silently applied. Init
writes the whole server side and prints the one paste that makes the agent
visible:

- the catch-all route `app/api/vendo/[...vendo]/route.ts` holding the entire
  `createVendo` composition (on Express or any other Web-standard runtime,
  `vendo/server.ts` instead)
- an empty component registry, `vendo/registry.tsx`
- the client mount `vendo/vendo-root.tsx` — a `"use client"` wrapper that
  applies the registry and the extracted theme and mounts `<VendoOverlay />`,
  the launcher pill + panel users actually see
- a printed paste for you: the import plus wrapping `{children}` in that
  wrapper in `app/layout.tsx`. Init never edits a file you authored, so this
  one step is yours — and it is the step that makes the install visible, so
  `vendo doctor` fails until it lands
- `vendo-actions.ts`, the server-action registration map, when `"use server"`
  actions are detected
- two `package.json` script hooks (`predev: vendo sync --no-ai`,
  `prebuild: vendo sync --strict --no-ai`)
- your tools and brand theme extracted into `.vendo/` (`tools.json`,
  `overrides.json`, `policy.json`, `brief.md`, `theme.json`,
  `theme.extracted.json`) plus `.env.example`

The mount paste is idempotent (init prints nothing when a Vendo surface is
already mounted) and bounded: one import line plus the `{children}` wrap. See
[the client mount](#vendovendo-roottsx--the-client-mount).

Then land the paste, start your dev server, and run `npx vendo doctor` to
verify everything with one real model turn.

## Non-interactive runs (agents)

Every init question has a value-flag answer, so a coding agent never hangs
on a prompt: `--auth <preset>` (authJs, clerk, supabase, auth0, jwt, none)
answers the auth confirm and picker, `--framework <next|express|custom>`
overrides detection (`custom` is the runtime-neutral scaffold for Cloudflare
Workers, Bun, Deno, Hono, and Lambda adapters), `--cloud-key <key>` or `--byo`
answers the Cloud offer, `--ai` grants consent for the AI pass (tool
judgment and theme-slot filling, one consent for both), and `--theme
slot=value` (repeatable) overrides a theme slot value directly. When a
decision has no flag and no detected default — an undetectable framework — a
non-interactive run errors with the exact flag to pass instead of guessing or
prompting.

## The files you own

A host's entire server wiring is two files: `vendo/registry.tsx`, which
declares the components generated views can use, and the composition — one
`createVendo` call with an auth preset and that registry. On Next.js the
composition lives inline in the catch-all route
`app/api/vendo/[...vendo]/route.ts`. A third file, `vendo/vendo-root.tsx`,
carries the client mount. All three are scaffolded by `vendo init` and yours
to change from there.

### `vendo/registry.tsx` — the component registry

One object, keyed by component name. Each entry holds the real component
reference, a description the model reads, and an optional zod props schema.
The same object serves both sides: `createVendo` reads the registry as
`catalog` and uses only the data fields; `<VendoRoot>` reads it as `components`
and uses only the component references. There is no second map to keep in
sync.

```tsx
// vendo/registry.tsx — generated empty by `vendo init`, then yours
import type { ComponentRegistry } from "@vendoai/vendo";
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

`ComponentRegistry` comes from `@vendoai/vendo`, not `@vendoai/core`: a host
only installs `@vendoai/vendo` (and `@vendoai/ui`), so under pnpm's strict
linking a transitive package doesn't resolve for host code. The umbrella's
root entry re-exports the full `@vendoai/core` type surface, so every contract
type is one specifier away.

The props schema is optional — a schema-less entry is legal and renders as a
description-only prompt entry the model infers props for. When a schema is
present, the model-facing JSON Schema is derived from it internally; you never
hand-write one.

### The catch-all route — the composition

```ts
// app/api/vendo/[...vendo]/route.ts — equivalent to what `vendo init` scaffolds
// (init writes a relative registry import; the `@/*` alias reads better here)
import { authJs } from "@vendoai/vendo/auth/auth-js";
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";
import { registry } from "@/vendo/registry";

const vendo = createVendo({
  // Detected next-auth — authJs() fills the identity seams
  // (request→user, actAs, door OAuth); options and the per-seam escape
  // hatch: docs/act-as-presets.md.
  auth: authJs(),
  catalog: registry,
  policy: {}, // .vendo/policy.json: destructive asks, reads run
});

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
```

There is no model line on purpose: the composed default resolves a real key
from the environment (see [Model keys](#model-keys) below), so the first turn
works before you have picked anything. To pin a model, name it in the `models`
block — the name passes through verbatim to whatever credential resolves, so
nothing extra needs installing on the Anthropic and Vendo Cloud rungs:

```ts
const vendo = createVendo({
  models: { agent: "claude-sonnet-4-6" },
  auth: authJs(),
  catalog: registry,
  policy: {},
});
```

For full control (BYO-LLM), pass any AI SDK `LanguageModel` object instead of
a name — `models: { agent: anthropic("claude-sonnet-4-6") }` — which is when
you install the matching `@ai-sdk/*@^3` provider yourself.

`authJs()` is zero-argument in the standard case: it reads `AUTH_SECRET`
(mirroring Auth.js itself) and derives the principal's display name and email
from the session-token claims. `auth` is one preset that fills all three
identity seams `createVendo` needs — the request→principal resolver, the
away/MCP `actAs` seam, and the door's OAuth adapter — from one config key.
Presets exist for Auth.js, Clerk, Supabase, Auth0, and a generic JWT scheme;
see [actAs preset recipes](./act-as-presets.md) for the full list, the
`user` resolver for custom identity mapping, and the per-seam escape hatch for
hosts without a shipped preset.

`models` and `catalog` are the only other keys most hosts touch on day one.
Every key is optional — `createVendo({})` legitimately boots, with an
env-resolved model, anonymous ephemeral sessions, and PGlite persistence. (The
config object itself is required: `createVendo()` with no argument does not
typecheck and throws at runtime.)
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

### `vendo/vendo-root.tsx` — the client mount

Init generates this wrapper; you mount it in your layout (init prints the
exact two lines). It is a `"use client"` boundary because the registry carries
component references, which cannot cross a Server Component boundary as props
(RSC serialization fails, and every page 500s).

```tsx
// vendo/vendo-root.tsx — generated by `vendo init`, then yours
"use client";

import { VendoOverlay, VendoRoot as VendoClientRoot } from "@vendoai/vendo/react";
import type { ReactNode } from "react";
import { registry } from "./registry";
import theme from "../.vendo/theme.json";
import type { VendoTheme } from "@vendoai/vendo";

export function VendoRoot({ children }: { children: ReactNode }) {
  return (
    <VendoClientRoot components={registry} theme={theme as VendoTheme}>
      {children}
      <VendoOverlay />
    </VendoClientRoot>
  );
}
```

`components` accepts the same registry object the composition passes as
`catalog` — it reads only the component references and ignores the data
fields. The `theme` prop applies the brand init captured; the cast narrows
TypeScript's widened JSON-module string literals.

`<VendoClientRoot>` is a context provider and renders nothing by itself,
which is why the generated wrapper mounts `<VendoOverlay />` inside it. Swap
that for `<VendoThread />`, `<VendoPage />`, `<VendoPalette />`, or the
headless hooks — they all speak to the same wire. The hooks and the BYO embeds
are re-exported from `@vendoai/vendo/react`, so they cost you nothing extra.
The other chrome surfaces live in `@vendoai/ui/chrome` and need `@vendoai/ui`
as a direct dependency; of the standalone surfaces, only `<VendoOverlay />` is
re-exported.

The paste init prints:

```tsx
// app/layout.tsx
import { VendoRoot } from "../vendo/vendo-root";

// then wrap the app:
<VendoRoot>{children}</VendoRoot>
```

## Model keys

The agent needs an LLM. `models.default` is optional: when you don't name a
model, the composed default resolves a real key from the environment, in this
order:

1. An explicit env key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `GOOGLE_GENERATIVE_AI_API_KEY` (init installs the matching `@ai-sdk/*@^3`
   provider for the key it resolves). This same rung serves production.
2. `VENDO_API_KEY` — a Vendo Cloud dev key. When init finds no key, it offers
   `vendo login`: your browser opens on the approval page (a non-TTY caller
   gets the URL and pairing code printed instead), you approve the code, and
   the minted metered API key is written to `.env.local` for you. You
   never paste a key. (`vendo cloud login <email>` remains as an email-OTP
   fallback.)
   Model calls go through the Vendo Cloud model gateway (`vendo` by
   default — pin another id with `VENDO_MODEL` or `models.default`, served via
   `@ai-sdk/anthropic`) and draw down the usage your plan includes.
3. Nothing available: chat fails honestly, with exact instructions in the
   server log.

Production deploys always need a real server-side key.

Vendo Cloud is optional. When `VENDO_API_KEY` is set, init validates it and
states the plan and what it unlocks; when it is absent, init prints one calm
line and offers `vendo login` only when a starter key would help.

## AI polish (tool judgment and theme)

Static extraction gets the facts; a coding agent adds the judgment. The
deterministic exact pass always reads conventional CSS tokens into
`theme.json` first; whatever slots it can't read ride this same
consent-gated pass. During an interactive `vendo init`, init asks once for
consent and lets the agent read your codebase (read-only: Read/Glob/Grep;
source goes to your model provider under your own account). It drafts
task-oriented tool descriptions, reviews risk grades, wakes statically
unclassifiable tools with reasoning, fills theme slots the exact pass
couldn't resolve, and writes the product brief. Nothing needs installing in
your app for any of this: no `@ai-sdk/anthropic`, no bundled SDK.

### Which engine runs it

Init resolves an engine for the pass through an ordered ladder — first
available rung wins, a rung that's missing or unauthenticated is skipped and
the next one is tried:

1. The Claude Agent SDK, when resolvable in your app (a Claude Code login or
   `ANTHROPIC_API_KEY` pays).
2. The `claude` CLI on PATH, driven headless and read-only — same
   credentials, plus corporate-gateway setups (`ANTHROPIC_AUTH_TOKEN`,
   `CLAUDE_CODE_OAUTH_TOKEN`, or a custom `ANTHROPIC_BASE_URL`). Your own
   endpoint is always honored, never overridden by anything below.
3. The `codex` CLI on PATH, driven headless and read-only. A ChatGPT login
   or `OPENAI_API_KEY` pays.
4. `@vendoai/engine`, fetched on the fly with `npm exec` at a pinned
   version — real Claude Code, no local install required. This is a
   one-time ~250MB download (npm caches it, so later runs skip it); init
   prints the download notice before it starts. `ANTHROPIC_API_KEY` pays,
   or `VENDO_API_KEY` through the Vendo Cloud model gateway.

When none of the four resolves, init still completes — extraction defaults
stand — and prints every rung's remedy. If a chosen rung fails partway
(a killed fetch, a 404, a network error), init reports it and leaves
defaults in place; re-run `vendo init` to retry.

Init-time inference through the Vendo Cloud gateway meters normally on paid
plans; free-plan orgs get a clear refusal pointing you at your own Claude
Code login or API key, or an upgrade. Your own credentials always work, on
every plan.

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
extracted tool names are accepted, every proposal carries a verbatim source
quote and is checked by an independent skeptic, waking a disabled tool requires
reasoning plus an explicit grade, and human decisions always win (existing
`.vendo/overrides.json` fields and a hand-written `brief.md` are never
overwritten).

Tightenings — a raised risk grade, a better description — apply themselves.
Loosenings do not: lowering a risk grade or waking a disabled tool is held as
`pending` in `.vendo/judgments.json` until a human approves it, which is the
aggregated review above. Any run with nobody to ask — `--yes` included — leaves
them pending and prints `vendo sync --review`, never applying them silently and
never stopping to wait. Judgments live in their own file, so
`overrides.json` keeps meaning only "what a person decided" and a re-sync can
never clobber either.

Without `--ai` the whole pass is skipped silently in non-interactive runs,
since consent cannot be assumed; re-run `vendo init` any time to add it.

## First turn

Open the mounted overlay and send a request such as “Build a view of my
overdue invoices.” The browser posts one turn to `/threads`. The response
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
  instead of local PGlite. Pass `store: createStore(...)` to keep data local;
- the knowledge slot becomes the Cloud knowledge engine when you passed no
  `knowledge`, and the agent gets its `vendo_knowledge_search` tool over the
  corpus you connected in the console. Pass `knowledge: vendoKnowledge()` (or
  any adapter) to keep retrieval yours — see [knowledge](./knowledge.md).

An explicitly passed adapter or BYO key always wins over these defaults.

Use the [actAs preset recipes](./act-as-presets.md) to wire Auth.js, Supabase
Auth, Clerk, Auth0, or a host-owned generic JWT without changing the
`AuthMaterial` contract.

Away execution cannot create its own authority: it requires an app-bound
automation grant captured while that user was present. Without that prior
grant, the run parks for approval before `actAs` is called.

## The whole configuration surface

Every key is optional. `models.default` resolves from the environment when
absent (see [Model keys](#model-keys)), and with neither `auth` nor
`principal` every session is ephemeral and anonymous. `auth` and any of
`principal`/`actAs`/`oauth` are mutually exclusive — supplying both throws a
validation error at compose time. Pick the preset or hand-wire the three
seams, never both.

`createVendo(config: CreateVendoConfig): Vendo`, in full. Every type is
importable by a host — the umbrella's root entry re-exports the contract types
and `@vendoai/vendo/server` carries the composition ones — and this block is
compiled against the real `CreateVendoConfig` in
`packages/vendo/src/cli/quickstart-config-surface.docs-check.ts`, so it cannot drift:

```ts
import type {
  ActAs, ActionsRegistry, AppsRuntime, AutomationsEngine, CatalogFile,
  ComponentCatalog, ComponentRegistry, Connector, ExtractedTool, FilesAdapter,
  Harness, HostOAuthAdapter, Json, Judge, KnowledgeAdapter, OverridesFile,
  PackProvider, PolicyConfig, PolicyFile, Principal, RunContext, RunId,
  SandboxAdapter, SecretsProvider, ToolRegistry,
  VendoAgent, VendoGuard, VendoStore, VendoTheme,
} from "@vendoai/vendo";
import type {
  AgentOptions, AppsConfig, ComposedAgent, ConnectionsService, HarnessTurns,
  HostAuthPreset, ModelsConfig, PackContext, ServerActionHandler, TourEntry,
} from "@vendoai/vendo/server";
import type { LanguageModel } from "ai";

export interface CreateVendoConfig {
  /** @deprecated superseded by `models.default`. */
  model?: LanguageModel;
  /** @deprecated the model half is superseded by `models.fill`; `disabled` stays. */
  paint?: { model?: LanguageModel; disabled?: boolean };
  models?: ModelsConfig;      // seats: default, reviewer, judge, fill, verifier
  auth?: HostAuthPreset;      // one preset fills principal + actAs + oauth
  principal?: (req: Request) => Promise<Principal | null>; // escape hatch
  tools?: ExtractedTool[];    // `vendo init`/`vendo sync` declarations, in memory
  catalog?: ComponentCatalog | ComponentRegistry;          // registry.tsx, or the array form
  theme?: VendoTheme;         // programmatic override for .vendo/theme.json
  brief?: string;             // programmatic override for .vendo/brief.md
  store?: VendoStore;
  files?: FilesAdapter;       // workspace file content; unset → blobs in the store, 5 MiB cap
  sandbox?: SandboxAdapter;
  harness?: Harness<never>;   // WHO THINKS. unset → vendo(). also: claudeCode()
  knowledge?: KnowledgeAdapter; // unset → no vendo_knowledge_search tool
  connectors?: Connector[];
  connectorApps?: string[];   // toolkit scope for the auto-composed Cloud connector
  connections?: ConnectionsService; // explicit connections adapter; always wins over defaults
  actAs?: ActAs;              // escape hatch
  serverActions?: Record<string, ServerActionHandler>; // the generated vendo-actions.ts map
  policy?: PolicyConfig;      // "cautious" | "readonly" | "autopilot" | { file } | { rules }
  judge?: Judge;
  secrets?: SecretsProvider;
  telemetry?: boolean;
  development?: boolean;    // dev-only injection seams
  profileDir?: string;        // the project root .vendo/ is read under
  fetch?: typeof fetch;       // the fetch host tool bindings execute through
  profile?: {                 // the same .vendo/ pieces, in memory (filesystem-less venues)
    tools?: ExtractedTool[];
    overrides?: OverridesFile;
    theme?: VendoTheme;
    brief?: string;
    catalog?: CatalogFile;
    policy?: PolicyFile;
    designRules?: string;
  };
  mcp?: boolean | {            // the door; `baseUrl` is its PUBLIC base URL
    baseUrl?: string;
    remoteAs?: { issuer: string; jwksUri?: string; audience: string };
    federation?: { secret: string };
  };
  oauth?: HostOAuthAdapter;   // escape hatch; required when `mcp` is true and `auth` is absent
  agent?: AgentOptions | ComposedAgent; // the chat knobs, OR a whole agent() from @vendoai/agents
  sessions?: { ttlMs?: number; sweepIntervalMs?: number; now?: () => number };
  approvals?: { parkedCallTtlMs?: number };
  apps?: {
    experimentalMachines?: boolean;
    experimentalScreenAgent?: boolean; // route vendo_make through the cheap screen agent first
    review?: {                // review-kind remixes: who may review (queue/reject/approve)
      reviewer?(ctx: RunContext): boolean | Promise<boolean>;
    };
    pipeline?: AppsConfig["pipeline"];                 // { smokeRender } — the island render gate
    checks?: AppsConfig["checks"];                     // the host's own checks, appended to the built-ins
    designRules?: string;
  };
  packs?: readonly PackProvider<PackContext>[]; // where capability comes from. unset → [apps()]
  tours?: readonly TourEntry[];
}

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent;
  guard: VendoGuard;
  guardedTools: ToolRegistry; // the guard-bound registry the vendo_* tool pack executes through
  apps: AppsRuntime;
  automations: AutomationsEngine;
  actions: ActionsRegistry;
  connections: ConnectionsService;
  store: VendoStore;
  harness: HarnessTurns;      // turns served through the composed Harness
}
```

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
extraction changes exit with code 2. A tool your API does not describe carries
an empty description — write one in `overrides.json`.

To make the deployed door discoverable through the official registry, follow
[Publish to the MCP registry](publish-mcp-registry.md).
