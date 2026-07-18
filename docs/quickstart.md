# Vendo quickstart

Install the default composition and run setup:

```bash
npm install @vendoai/vendo
npx vendo init
```

The `vendoai` package is a thin alias. The scoped package is the canonical
install. `vendo init` asks nothing on the happy path. It writes one code file
(the catch-all handler) and two package.json script hooks, extracts your tools
and brand theme into `.vendo/`, resolves a model key, and prints the one line
that is yours to paste: the `<VendoRoot>` wrap in your layout. It never edits
code you wrote. Then start your dev server — the agent is live in your app —
and run `npx vendo doctor` to verify everything with one real model turn.

## Model keys

The agent needs an LLM. `createVendo`'s `model` is optional: when you don't
pass one, the composed default resolves a real key from the environment, in
this order:

1. An explicit env key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
   `GOOGLE_GENERATIVE_AI_API_KEY` (install the matching `@ai-sdk/*@^3`
   provider). This same rung serves production.
2. `VENDO_API_KEY` — a Vendo Cloud dev key. When init finds no key, it offers
   `vendo cloud login`: after the browser login it mints a metered dev-mode
   starter key and writes it to `.env.local` for you. You never paste a key.
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

## AI polish (extraction judgment)

Static extraction gets the facts; a coding agent adds the judgment. During an
interactive `vendo init`, when `@anthropic-ai/claude-agent-sdk` is resolvable
and a Claude Code login or `ANTHROPIC_API_KEY` exists, init asks once for
consent and lets the agent read your codebase (read-only: Read/Glob/Grep;
source goes to your model provider under your own account). It drafts
task-oriented tool descriptions, reviews risk grades, wakes statically
unclassifiable tools with reasoning, and writes the product brief.

Everything it proposes passes deterministic guards before applying: only
extracted tool names are accepted, risk can be raised but never lowered,
waking a disabled tool requires reasoning plus an explicit grade, and human
decisions always win (existing `.vendo/overrides.json` fields and a
hand-written `brief.md` are never overwritten). The output lands in the
override channel, so `vendo sync` regeneration keeps it. Skipped silently in
non-interactive runs; re-run `vendo init` any time to add it.

## Create the server

`createVendo` has this exact configuration surface:

```ts
import type { Principal, ActAs, SecretsProvider, Json, RunId } from "@vendoai/core";
import type { LanguageModel } from "ai";
import type { VendoStore } from "@vendoai/store";
import type { VendoAgent } from "@vendoai/agent";
import type { ActionsRegistry, Connector } from "@vendoai/actions";
import type { VendoGuard, PolicyConfig, Judge } from "@vendoai/guard";
import type { AppsRuntime, SandboxAdapter } from "@vendoai/apps";
import type { AutomationsEngine } from "@vendoai/automations";
import type { HostOAuthAdapter } from "@vendoai/mcp";

export function createVendo(config: {
  model?: LanguageModel;         // absent → env-resolved key (see Model keys above)
  principal: (req: Request) => Promise<Principal | null>;
  store?: VendoStore;
  sandbox?: SandboxAdapter;
  connectors?: Connector[];
  actAs?: ActAs;
  policy?: PolicyConfig;
  judge?: Judge;
  secrets?: SecretsProvider;
  telemetry?: boolean;
  mcp?: boolean;               // open the door: serve host tools to MCP clients
  oauth?: HostOAuthAdapter;    // required when mcp is true
  sessions?: {                 // anonymous (ephemeral) session lifecycle
    ttlMs?: number;            // idle timeout, default 30 min; 0 disables TTL
    sweepIntervalMs?: number;  // sweep cadence, default 60 s
  };
}): Vendo;

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent; guard: VendoGuard; apps: AppsRuntime; automations: AutomationsEngine; actions: ActionsRegistry; connections: ConnectionsService; store: VendoStore;
}
```

The principal resolver is the only required configuration (`model` resolves
from the environment when absent). Returning `null` from `principal` creates
an ephemeral session-scoped principal. That session works normally but does
not persist.

```ts
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";

const vendo = createVendo({
  principal: async (request) => {
    const user = await resolveSession(request);
    return user ? { kind: "user", subject: user.id, display: user.name } : null;
  },
});

export const { GET, POST, DELETE } = nextVendoHandler(vendo);
```

Mount the route at `/api/vendo/[...]`. The fetch handler itself is
framework-agnostic.

## Add the React root

```tsx
import { VendoRoot } from "@vendoai/vendo/react";

export function Root({ children }: { children: React.ReactNode }) {
  return <VendoRoot>{children}</VendoRoot>;
}
```

Use the headless hooks from `@vendoai/ui`, or add a shipped surface from
`@vendoai/ui/chrome`. `<VendoThread />`, `<VendoOverlay />`, `<VendoPage />`,
and `<VendoPalette />` all speak to the same wire.

## First turn

Open the mounted conversation surface and send a request such as “Build a view
of my overdue invoices.” The browser posts one turn to `/threads`. The response
is an AI SDK UI message stream. Any generated app surface arrives in a
`data-vendo-view` part and any approval metadata in a `data-vendo-approval`
part.

Set `VENDO_BASE_URL` to the host origin (for example,
`http://localhost:3000`) before starting the server. Present tool calls forward
the inbound request's cookie and authorization headers only when this trusted
origin is set; without it, route execution still works but forwards no
credentials. Every call passes through the guard. With no policy or judge,
calls auto-run and are audited, and shipped chrome displays the
unconfigured-policy notice.

## What works without more configuration

- PGlite persistence at `.vendo/data`
- tree-only apps, including host and generated components
- threads, approvals, grants, activity, and app lifecycle routes
- schedule, host-event, and external-trigger automation machinery

A sandbox adapter unlocks server-backed app rungs. `actAs` unlocks host API
calls while the user is away. Connectors add external tools. `VENDO_API_KEY`
activates cloud-gated sharing, publishing, org overlays, and pinning.

Use the [actAs preset recipes](./act-as-presets.md) to wire Auth.js, Supabase
Auth, Clerk, Auth0, or a host-owned generic JWT without changing the
`AuthMaterial` contract.

Away execution cannot create its own authority: it requires an app-bound
automation grant captured while that user was present. Without that prior
grant, the run parks for approval before `actAs` is called.

## Serve your product to MCP clients (the door)

The door makes your host tools installable in Claude, ChatGPT, Cursor, and any
MCP client. Enable it with one flag and one seam:

```ts
const vendo = createVendo({
  principal,
  actAs,          // see below
  mcp: true,
  oauth: hostOAuth,
});
```

`oauth` uses the host's existing session and subject resolver. The door owns the
OAuth protocol and the complete consent UI.

```ts
import type { HostOAuthAdapter } from "@vendoai/mcp";

const hostOAuth: HostOAuthAdapter = {
  // Use the exact returnTo: after login the door resumes the OAuth request once,
  // sees the new session, and shows consent instead of bouncing back to login.
  session: async (req, { returnTo }) => {
    const subject = await currentSubject(req);
    if (subject) return { subject };
    const login = new URL("/login", req.url);
    login.searchParams.set("returnTo", returnTo);
    return Response.redirect(login);
  },
  // Resolve a subject to the principal the door executes as. null revokes.
  principal: async (subject) => resolveUser(subject),
};
```

The prebuilt page uses the same `--vendo-*` CSS token namespace as the UI
pipeline; `createVendo` automatically passes the resolved `.vendo/theme.json`
theme into it. The page CSRF-protects approve/deny, rejects decision replay,
escapes the attacker-controlled DCR `client_name`, and returns the standard
OAuth code or `access_denied` redirect.

Need a fully custom page? Add `authorize(req, ctx)` alongside `session`. Render
your page from `ctx.clientName`/`ctx.scopes` (escape both), then submit hidden
`transaction` and `csrf_token` values from `ctx.consent` plus
`decision=approve|deny` to `ctx.consent.action`. The door keeps ownership of the
flow and validation.

MCP clients have no host browser session, so door tool calls cannot forward
cookies. They authenticate over the **same `actAs` seam** away automations use.
There is one seam, not two: `actAs` now backs both away automations and MCP
host calls. If you already implemented `actAs`, the door reuses it. If you have
not, host tool calls over the door degrade cleanly with a not-implemented tool
error, exactly like away execution on a host that never wired the seam.

Policy posture: the shipped policy example blocks `venue: "mcp"`. Opening the
door is a host decision, never a default — it happens here, deliberately,
after setup; `vendo init` never asks about it.

The door also serves discovery documents at the origin root, which the
`/api/vendo/[...]` catch-all cannot see. In a Next.js host, add this route
(under `src/app` when that layout is present); it allows only the door's four
exact paths and 404s everything else, so it never shadows host OAuth/OIDC
metadata:

```ts
// app/.well-known/[...vendo]/route.ts
import { vendo } from "@/lib/vendo";

const DOOR_PATHS = new Set([
  "/.well-known/oauth-protected-resource/api/vendo/mcp",
  "/.well-known/oauth-authorization-server/api/vendo/mcp",
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp-server-card",
]);

const forward = (req: Request) =>
  DOOR_PATHS.has(new URL(req.url).pathname)
    ? vendo.handler(req)
    : new Response(null, { status: 404 });
export const GET = forward;
export const POST = forward;
```

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
exit code — for scripts and agents.

`sync` extracts the host API and remix baselines. In strict mode, breaking
extraction changes exit with code 2.

To make the deployed door discoverable through the official registry, follow
[Publish to the MCP registry](publish-mcp-registry.md).
