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

## Check the install

```bash
npx vendo doctor
npx vendo sync
```

`doctor` checks wiring and makes one live `/status` probe. `sync` extracts the
host API and remix baselines. In strict mode, breaking extraction changes exit
with code 2.
