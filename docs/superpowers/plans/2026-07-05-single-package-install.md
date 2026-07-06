# Single-Package Install (`vendo`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `@vendoai/next` install path with one public npm package, `vendo`, exposing `vendo/server`, `vendo/react`, and a types-only root, plus a working `npx vendo init`.

**Architecture:** ai-SDK umbrella topology — `vendo` is a thin re-export package over the `@vendoai/*` internals, which keep publishing but become undocumented. `@vendoai/next` is dissolved: its server half joins `@vendoai/server`; its React half becomes a new internal `@vendoai/client` package (top of the React stack).

**Spec:** `docs/superpowers/specs/2026-07-05-single-package-install-design.md`

**Deviation from spec §3 (flagged for Yousef):** the spec said the client half moves into `@vendoai/react`. That creates a dependency cycle — `@vendoai/shell` already depends on `@vendoai/react`, and the client half imports `@vendoai/shell` twelve times. So the client half instead becomes a new internal package `@vendoai/client` (`packages/vendo-client`), which depends on shell, react, components, core, and the client-safe deep imports of server. The public surface (`vendo/react`) is identical either way.

**Rule reminders:** never commit to main (work on a feature branch); UI-affecting changes need real-browser screenshots in the PR; `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before PR.

---

### Task 0: Branch

- [ ] Create a feature branch off `main` (e.g. `yousefh409/single-package-vendo`).

### Task 1: Move the server half of `@vendoai/next` into `@vendoai/server`

The `{GET, POST}` wrapper contains zero Next.js code; it belongs beside `createVendoFetchHandler`.

**Files:**
- Move: `packages/vendo-next/src/handler.ts` → `packages/vendo-server/src/route-handler.ts` (rename `VendoRouteHandlers` docs to drop "Next adapter" framing; it's just the fetch-handler pair any catch-all route mounts)
- Move: `packages/vendo-next/src/handler.test.ts` → `packages/vendo-server/src/route-handler.test.ts`
- Modify: `packages/vendo-server/src/index.ts` — export `createVendoHandler` and `VendoRouteHandlers`
- Modify: `packages/vendo-next/src/handler.ts` consumers — `packages/vendo-next/src/index.ts` temporarily re-exports from `@vendoai/server` so the repo stays green mid-migration

**Steps:**
- [ ] Move the handler and its test; adjust imports (the test currently exercises the handler through `@vendoai/next` — point it at the server package).
- [ ] Export the handler from `@vendoai/server`'s index; make `@vendoai/next` re-export it.
- [ ] Update docblocks in `packages/vendo-server/src/fetch-handler.ts` and `index.ts` that describe `@vendoai/next` as "the adapter".
- [ ] Run `pnpm --filter @vendoai/server --filter @vendoai/next build test typecheck` — green.
- [ ] Commit.

### Task 2: Create `@vendoai/client` and move the React half into it

**Files:**
- Create: `packages/vendo-client/package.json` (name `@vendoai/client`, version 0.1.0, same license/repo/engines/publishConfig boilerplate as `packages/vendo-react/package.json`; deps: `@vendoai/core`, `@vendoai/react`, `@vendoai/shell`, `@vendoai/components`, `@vendoai/server` (client-safe deep imports only), `ai`, `zod`; peers: react, react-dom; same tsc build/test/typecheck scripts and devDeps as vendo-react)
- Create: `packages/vendo-client/tsconfig.json` (copy `packages/vendo-next/tsconfig.json` shape)
- Move: everything under `packages/vendo-next/src/client/` → `packages/vendo-client/src/` (vendo-root, sandbox-stage, connect-flow, connect-node, integrations, navigate, notifications, run-query, server-store, voice — tests move with their code)
- Create: `packages/vendo-client/src/index.ts` from the old `client/index.ts` (update the package-name constant)

**Steps:**
- [ ] Scaffold the package; move the eleven source/test files; fix relative imports (they were written for a `client/` subfolder).
- [ ] Make `@vendoai/next`'s `./client` entry temporarily re-export `@vendoai/client` so demos stay green.
- [ ] Check `packages/vendo-server/src/client-safe-guard.test.ts` — its comment names `@vendoai/next/client`; repoint the wording at `@vendoai/client`. The guard's actual assertions are unchanged.
- [ ] Run `pnpm build && pnpm test && pnpm typecheck` at the repo root (new package enters the turbo graph via the `packages/*` workspace glob) — green.
- [ ] Commit.

### Task 3: Create the `vendo` umbrella package

**Files:**
- Create: `packages/vendo/package.json` — name `vendo` (bare, unscoped), exports map: `.` → types-only entry, `./server` → server re-export, `./react` → react re-export; `bin: { vendo: ./bin/vendo.mjs }`; deps: `@vendoai/core`, `@vendoai/server`, `@vendoai/react`, `@vendoai/shell`, `@vendoai/client`, `@vendoai/components` (all `workspace:*`); peers react/react-dom marked optional via `peerDependenciesMeta` so server-only installs don't warn
- Create: `packages/vendo/src/index.ts` — type-only re-exports from `@vendoai/core` plus `BrandTokens` from `@vendoai/components/theme`; no runtime code
- Create: `packages/vendo/src/server.ts` — re-exports `@vendoai/server` (which now includes `createVendoHandler`)
- Create: `packages/vendo/src/react.ts` — re-exports `@vendoai/client`, `@vendoai/react`, and `@vendoai/shell` public surfaces (resolve any name collisions explicitly with named re-exports; tsc will flag them)
- Create: `packages/vendo/bin/vendo.mjs` — zero-dependency stub: reads its own package version, spawns `npx -y @vendoai/cli@<version>` with the passed args, forwards exit code
- Create: `packages/vendo/tsconfig.json`

**Steps:**
- [ ] Scaffold the package with the three entrypoints and the bin stub.
- [ ] Build and typecheck; fix any export-name collisions between client/react/shell surfaced by tsc.
- [ ] Add a small test (vitest, matching sibling packages) asserting the three entrypoints resolve and the root entry exports no runtime values (types only) — this is the client/server-boundary safety property.
- [ ] Run root `pnpm build && pnpm test && pnpm typecheck` — green.
- [ ] Commit.

### Task 4: Point the CLI at `vendo`

**Files:**
- Modify: `packages/vendo-cli/src/next-wiring.ts` — generated route imports `createVendoHandler` from `vendo/server` (line ~95); generated layout imports `VendoRoot` from `vendo/react` (line ~114); instrumentation snippet imports `startVendoScheduler` from `vendo/server` (line ~182); `package.json` dependency added is `vendo` not `@vendoai/next` (lines ~310, ~834–854); the installed-packages list at lines ~50–52 becomes just `vendo`; all "see @vendoai/next" manual-fallback strings reworded
- Modify: `packages/vendo-cli/src/local-pack.ts` — `LOCAL_DIRECT_DEPENDENCIES` becomes `["vendo"]`; confirm the transitive-closure packing picks up `@vendoai/client` and the rest of the umbrella's dependency tree
- Modify: sandbox-asset copy in `next-wiring.ts` (lines ~810–825) — the copy source must resolve through `vendo`'s dependency closure now that `@vendoai/next` is gone; verify the resolution root and update it
- Modify: `packages/vendo-cli/src/next-wiring.test.ts`, `init.test.ts`, `local-pack.test.ts` — expectations follow the new package name and import paths

**Steps:**
- [ ] Update the wiring templates, dependency merge, install list, and manual-fallback strings.
- [ ] Update local-pack and the tests.
- [ ] Run `pnpm --filter @vendoai/cli build test typecheck` — green.
- [ ] Commit.

### Task 5: Migrate in-repo consumers (demos, examples, docs)

**Files:**
- Modify: `apps/demo-bank` — `package.json` (drop `@vendoai/next`, add `vendo: workspace:*`), `src/app/api/vendo/[...path]/route.ts`, `src/vendo/handler-options.ts`, `src/vendo/agent.ts`, `src/vendo/connections-store.ts`, `src/instrumentation.ts` → imports become `vendo/server` or `vendo/react` as appropriate
- Modify: `apps/demo-accounting` — same treatment: `package.json`, `src/vendo/{chat,consent,parked-actions}-handler.ts`, `src/vendo/agent.ts`, `src/vendo/store.ts`, `src/components/vendo/SandboxStage.tsx`
- Modify: `examples/node/src/App.tsx` and `examples/node/README.md` — `VendoRoot` from `vendo/react`; the README's "plain React, no Next" pitch now reads naturally
- Modify: `docs/quickstart.md` — `npm install vendo`, `npx vendo init`, imports from `vendo/server`; rewrite the "Next.js is the first adapter" paragraph (~line 229) around the framework-neutral handler (`createVendoHandler` for catch-all routes, `toNodeHandler` for Express/node:http)
- Modify: `docs/persistence-and-deploy.md` — scheduler import from `vendo/server` (~lines 93–99)
- Sweep: remaining `@vendoai/next` mentions in comments (`packages/vendo-shell/src/use-trust-data.ts:5` and any others `grep -rn "@vendoai/next"` still finds outside `packages/vendo-next`)

**Steps:**
- [ ] Migrate demo-bank, then demo-accounting; keep their other direct `@vendoai/*` deps (shell, components, stage build scripts) as-is — in-repo internals are allowed to use internals.
- [ ] Migrate examples/node and both docs pages.
- [ ] Sweep comment references.
- [ ] Run root `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — green.
- [ ] Commit.

### Task 6: Delete `@vendoai/next`

**Files:**
- Delete: `packages/vendo-next/` entirely (its two entrypoints are now pure re-export shims with no consumers)

**Steps:**
- [ ] Confirm zero references: `grep -rn "@vendoai/next" --include="*.{ts,tsx,json,md}"` across the repo (excluding frozen historical docs, per rename-status convention) returns nothing live.
- [ ] Delete the package; run root `pnpm install` to refresh the lockfile.
- [ ] Run root `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — green.
- [ ] Commit.

### Task 7: End-to-end verification

- [ ] Scratch-app drill: create a throwaway Next.js app outside the repo, run the CLI's local-pack flow, then `vendo init` against it; verify the route, layout, sandbox assets, and `package.json` land correctly and the app boots with chat working.
- [ ] Bin-stub drill: from the scratch app, run `npx vendo <cmd>` via the packed tarball and confirm it delegates to the CLI.
- [ ] Browser check (repo rule): run demo-bank and demo-accounting, exercise a chat turn with generated UI, screenshot both for the PR.
- [ ] Full gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — green.
- [ ] Open the PR (base `main`) with screenshots; note the spec deviation (`@vendoai/client`) and the npm-name-claim action item for Yousef in the description.

### Out of scope

- Publishing anything to npm (gated on ENG-198); claiming the `vendo` name is Yousef's action item.
- Remix/Vite auto-wiring (CLI stays detection-only for them).
