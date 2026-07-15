# Vendo quickstart

Install the default composition and run the setup interview:

```bash
npm install @vendoai/vendo
npx vendo init
```

The `vendoai` package is a thin alias. The scoped package is the canonical
install. `vendo init` proposes two host changes: a catch-all handler and a
`<VendoRoot>` wrapper. It shows each diff before writing it.

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
  model: LanguageModel;
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
}): Vendo;

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent; guard: VendoGuard; apps: AppsRuntime; automations: AutomationsEngine; actions: ActionsRegistry; store: VendoStore;
}
```

The model and principal resolver are the only required configuration. Returning
`null` from `principal` creates an ephemeral session-scoped principal. That
session works normally but does not persist.

```ts
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";

const vendo = createVendo({
  model,
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

Present tool calls forward the inbound request's cookie and authorization
headers to same-origin host routes. Every call passes through the guard. With
no policy or judge, calls auto-run and are audited, and shipped chrome displays
the unconfigured-policy notice.

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

## Serve your product to MCP clients (the door)

The door makes your host tools installable in Claude, ChatGPT, Cursor, and any
MCP client. Enable it with one flag and one seam:

```ts
const vendo = createVendo({
  model,
  principal,
  actAs,          // see below
  mcp: true,
  oauth: hostOAuth,
});
```

`oauth` is a two-function `HostOAuthAdapter`. The door owns all OAuth protocol
mechanics. The host owns exactly two answers: who is this user, and did they
consent.

```ts
import type { HostOAuthAdapter } from "@vendoai/mcp";

const hostOAuth: HostOAuthAdapter = {
  // Authenticate with your existing session machinery and confirm scope consent.
  authorize: async (req, { clientName, scopes }) => {
    const subject = await confirmConsentWithHostLogin(req, clientName, scopes);
    return { subject };
  },
  // Resolve a subject to the principal the door executes as. null revokes.
  principal: async (subject) => resolveUser(subject),
};
```

MCP clients have no host browser session, so door tool calls cannot forward
cookies. They authenticate over the **same `actAs` seam** away automations use.
There is one seam, not two: `actAs` now backs both away automations and MCP
host calls. If you already implemented `actAs`, the door reuses it. If you have
not, host tool calls over the door degrade cleanly with a not-implemented tool
error, exactly like away execution on a host that never wired the seam.

Policy posture: the shipped policy example blocks `venue: "mcp"`. Opening the
door is a host decision, never a default. `vendo init` asks before opening it.

The door also serves discovery documents at the origin root, which the
`/api/vendo/[...]` catch-all cannot see. When you opt into MCP during `vendo init`
in a Next.js host, init generates `app/.well-known/[...vendo]/route.ts` (under
`src/app` when that layout is present) and forwards through the same handler.
The generated route allows only the door's four exact paths and 404s everything
else, so it never shadows host OAuth/OIDC metadata. If you wire Vendo without
init, add the equivalent route manually:

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
npx vendo sync
```

`doctor` checks wiring and makes one live `/status` probe. `sync` extracts the
host API and remix baselines. In strict mode, breaking extraction changes exit
with code 2.
