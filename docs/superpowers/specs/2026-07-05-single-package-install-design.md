# Single-package install: `vendo`

**Date:** 2026-07-05
**Status:** Approved (brainstorm with Yousef)
**Owner:** Yousef

## Problem

Today's install story leads with `@vendoai/next`, a framework-specific
adapter package. Yousef doesn't want hosts to install a framework adapter —
they should "just install normally": one package, one name.

Audit finding that makes this cheap: `@vendoai/next` contains no Next.js
code. Its server half is a 31-line `{GET, POST}` wrapper over
`createVendoFetchHandler` from `@vendoai/server`; its client half
(`VendoRoot`, `SandboxStage`, voice driver, connect flow, ~1,900 lines) is
pure React with zero `next/*` imports. The package is Next-specific in name
only.

## Decision

One public package, published as bare **`vendo`** (unclaimed on npm as of
2026-07-05, along with `vendoai` and `vendo-ai`). The developer experience:

```bash
npm install vendo
npx vendo init
```

```ts
// app/api/vendo/[...path]/route.ts
import { createVendoHandler } from "vendo/server";
export const { GET, POST } = createVendoHandler();

// app UI
import { VendoRoot } from "vendo/react";

// types anywhere
import type { VendoUIMessage } from "vendo";
```

## Design

### 1. Topology: the ai-SDK model

`vendo` is a thin umbrella package (new `packages/vendo`) whose only code is
re-export entrypoints plus a CLI bin stub. The existing `@vendoai/*`
workspace packages still publish to npm — npm needs the umbrella's
dependencies resolvable — but they become undocumented internals, exactly
how Vercel ships `ai` + `@ai-sdk/*`. Docs, README, and the CLI only ever
mention `vendo`.

Rejected alternatives:
- **Bundle everything into one artifact** (only `vendo` on npm): a real
  build-engineering project — components CSS, sandbox iframe assets,
  `"use client"` boundaries, and Node-only imports all have to survive a
  bundler. Purity nobody observes, at launch-adjacent risk.
- **Physically merge 12 packages into one**: rewrites every import, the
  turbo graph, and the dependency-guard CI test; user-visible result is
  identical to the umbrella.

### 2. Export map: symmetric subpaths (Convex style)

- `vendo/server` → re-exports `@vendoai/server`: `createVendoHandler`,
  `createVendoFetchHandler`, `toNodeHandler`, `startVendoScheduler`,
  `ingestVendoEvent`, and the rest of the server surface.
- `vendo/react` → re-exports `@vendoai/react`, which absorbs the
  batteries-included client (see §3): `VendoRoot`, provider, transport,
  `useVendoChat`, connect flow, voice.
- `vendo` (root) → shared **types only**, re-exported from `@vendoai/core`
  (+ `BrandTokens` from components): `VendoUIMessage`, manifest types, etc.
  No runtime code at the root — every runtime import states its side of the
  wire.

A single do-everything root entrypoint is technically impossible: client
components importing it would drag `node:fs`/drizzle into the browser
bundle. Root-as-React (Clerk style) was considered and passed over in favor
of the most conventional, self-documenting shape.

`react` is a peer dependency of `vendo` (via `@vendoai/react`); server-only
consumers importing only `vendo/server` are unaffected.

### 3. `@vendoai/next` is deleted; contents rehomed by kind

- Server half: `createVendoHandler()` (the `{GET, POST}` pair) moves into
  `@vendoai/server` next to `createVendoFetchHandler`. It stops being framed
  as a "Next adapter" — it's just an object of fetch handlers that happens
  to be the shape Next wants.
- Client half: `VendoRoot`, `SandboxStage`, connect flow/node, voice driver,
  navigate guard, notifications, server-store move into a new internal
  package `@vendoai/client` (`packages/vendo-client`). (Amended 2026-07-05,
  approved by Yousef: originally `@vendoai/react`, but `@vendoai/shell`
  depends on `@vendoai/react` and this code imports shell heavily — moving
  it into react would create a cycle. `@vendoai/client` sits at the top of
  the React stack: client → shell → react → stage/core.)
- Tests move with their code. The `packages/vendo-next` directory is removed
  from the workspace, turbo graph, and dependency-guard allowlist; the new
  `packages/vendo` is added.

### 4. `npx vendo init` mechanics

`npx vendo init` resolves the *package* named `vendo`, so the umbrella ships
a ~10-line zero-dependency bin stub that delegates to
`npx -y @vendoai/cli@<same version> <args>`. Host apps that install `vendo`
never get the CLI's heavy deps (esbuild, typescript, tailwind CLI) in their
node_modules; only people running init pay for them, transiently.
`@vendoai/cli` keeps its existing `vendo` bin name (hosts never install it
directly, so no bin collision).

The CLI codemod is updated to:
- install `vendo` instead of `@vendoai/next` (+ peers),
- write `vendo/server` / `vendo/react` / `vendo` imports in generated code,
- include `packages/vendo` in `local-pack` tarball testing.

### 5. Migration (dogfood proof)

All in-repo consumers move to `vendo` imports:
- `apps/demo-bank` (route, agent, handler-options, connections-store,
  instrumentation)
- `apps/demo-accounting` (handlers, agent, store, SandboxStage)
- `examples/node` (README + App.tsx)
- `docs/quickstart.md`, `docs/persistence-and-deploy.md`

The demos become the proof that the umbrella resolves correctly end to end.

### 6. Verification

- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- Real `vendo init` run against a scratch Next.js app via `local-pack`.
- Browser check of demo-bank (and demo-accounting) — UI-affecting per repo
  rules, screenshots in the PR.

### 7. Out of scope / follow-ups

- **Claim the npm name**: `vendo` is squattable today. Publishing a
  placeholder 0.0.1 under the org is Yousef's call (needs his npm keys);
  flagged, not part of this change.
- Actual publish remains gated on ENG-198.
- No new framework adapters (Remix/Vite wiring in the CLI stays detection-
  only, as today).
