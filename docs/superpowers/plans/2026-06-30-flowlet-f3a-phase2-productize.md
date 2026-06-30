# Flowlet F3a — Phase 2 (Productize) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Shipped code → full TDD, two-stage review per task. Steps use checkbox (`- [ ]`).

**Goal:** Turn the validated F3a spike into a real, shipped `@flowlet/stage` package + a `flowlet-react` adapter, with real-browser tests in CI.

**Architecture:** `@flowlet/stage` = framework-agnostic stage host (iframe + CSP + bridge + chokepoint) and a separately-built sandbox-runtime inner bundle. The spike (`spike/`) is the *validated reference implementation* — Phase 2 re-implements it as typed, tested package code and adds the four things the spike did NOT prove: shared-React delivery, capability mint/validate, approval-pending dispatch, and `ui/update`.

**Reference:** `spike/` (proven code), `spike/FINDINGS.md`, spec `docs/superpowers/specs/2026-06-30-flowlet-f3a-sandbox-runtime-design.md` (§4 transport, §6 provisioning, §7 frozen `StageCapabilities`, §9 errors/security, §12 findings). Engineers MAY read `spike/*` as the reference; this plan specifies the productized deltas.

**Tech Stack:** TypeScript, pnpm 9 workspace (`packages/*`), Turborepo, Vitest (unit, mock postMessage), Playwright + axe-core (real-browser CI), tsup or tsc + esbuild for the inner-bundle build.

---

## Design resolutions (the spike's open items — decided here; flagged for review)

1. **Shared-React delivery (replaces per-bundle ~200KB React).** The stage ships React+ReactDOM as **`blob:` ESM modules** and injects an **inline import map** in the srcdoc mapping `react` / `react-dom/client` → those blob URLs (inline import map is CSP-`unsafe-inline`-allowed; blob targets are `script-src blob:`-allowed — the spike's blocker was mapping to `/node_modules`, not blob). Host bundles are built with React **externalized**, so they resolve `react` to the one shared blob. One React, no per-bundle duplication. *Fallback if the import-map/blob path misbehaves: keep React bundled per host bundle (the spike's proven path) and accept the size — gated by P2-4's test.*
2. **Capability (transport security, F3a-owned).** On `ui/initialize`, the host mints a random opaque token **per node id**, keeps the `nodeId→token` map host-side, and includes each node's token in the tree it sends. A `tools/call` must echo the token for its `originNodeId`; the host validates `token === map[originNodeId]` and rejects on mismatch (`bridge`/`capability` error). Prevents a compromised node from spoofing another's actions. (Minting *policy* — scope/expiry/severity — stays F2.)
3. **Approval-pending dispatch.** `dispatch` resolves immediately with `{ status: "pending", actionId }` when the host handler signals deferral; the eventual result is pushed back over the bridge as a `ui/action-result` message keyed by `actionId`, which the runtime correlates to resolve the original caller. Tested against a host handler that defers then resolves later (no F2 needed). This is the shape that survives refresh/serverless (F1 §5.5) — the held-promise spike shape is replaced.
4. **`ui/update` (transport, F3a-owned; smart reconciliation is F3b).** A `ui/update` message carries `{ nodeId, node }` (replace) or `{ theme }` / `{ state }`. The stage's stub mount re-renders (full re-render of the tree is fine for F3a; F3b does incremental). Proves the `subscribe`/update half of `StageCapabilities`.

---

## File structure (`packages/flowlet-stage/`)

- `src/bridge.ts` — `makeRpc` transport: correlation, timeout, abort, typed errors.
- `src/protocol.ts` — bridge message types (`ui/initialize`, `ui/update`, `tools/call`, `ui/action-result`), error codes.
- `src/stage-host.ts` — framework-agnostic: `createStage`, `initStage`, `updateStage`, chokepoint termination → F1 `ActionRequest`/`ActionResult`, capability mint/validate, approval-pending.
- `src/runtime/` — the inner sandbox runtime (bootstrap, bundle-as-data loader, theme, `$state` binding, descriptor dispatch, error boundaries, ResizeObserver, `ui/update` apply). Built to a string the host injects.
- `src/react-runtime.ts` — shared-React blob ESM + import-map injection.
- `src/index.ts` — public exports + `StageCapabilities` type (spec §7).
- `tests/unit/*.test.ts` — Vitest + mock postMessage (bridge, capability, pending).
- `tests/browser/*.spec.ts` — Playwright + axe (the spike's 8 gates, as shipped CI).
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`.

`packages/flowlet-react/` gains `src/stage-adapter.tsx`; `examples/basic` wires the real stage.

---

## P2-1: Carve the `@flowlet/stage` package

**Files:** Create `packages/flowlet-stage/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`

- [ ] **Step 1: Create `packages/flowlet-stage/package.json`** — mirror `packages/flowlet-core/package.json` (read it first for exact field shape: `type:module`, `main/types` → `dist`, scripts `build`/`test`/`typecheck`). Deps: `"@flowlet/core": "workspace:*"`. devDeps: `vitest`, `typescript` matching the repo versions.
- [ ] **Step 2: Create `tsconfig.json` + `vitest.config.ts`** copying `packages/flowlet-core`'s.
- [ ] **Step 3: Create `src/index.ts`** exporting the `StageCapabilities` interface verbatim from spec §7 (with the concrete `ThemeTokens`/`StateProjection`/`ComponentImpl` types). Write a trivial Vitest asserting the module imports.
- [ ] **Step 4:** `pnpm install` (workspace picks up the new package), then `pnpm --filter @flowlet/stage build && pnpm --filter @flowlet/stage typecheck` → green.
- [ ] **Step 5: Commit** `feat(stage): carve @flowlet/stage package`.

## P2-2: Bridge transport (TDD, Vitest + mock postMessage)

**Files:** Create `src/protocol.ts`, `src/bridge.ts`, `tests/unit/bridge.test.ts`

- [ ] **Step 1: Write failing tests** for `makeRpc` against a **mock postMessage pair** (two `EventTarget`s wired to each other): (a) a call resolves with the peer's result; (b) a call rejects on timeout; (c) an in-flight call rejects on `abort` via an `AbortSignal`; (d) a malformed/uncorrelated message is ignored; (e) the peer's `onRequest` handler errors → caller gets a typed `{ code, message }`. Reference `spike/bridge.ts` for the base shape; the production version adds abort + typed errors + the `protocol.ts` message/error types.
- [ ] **Step 2: Run → fail. Step 3: Implement** `src/protocol.ts` (message + error-code types from spec §9: `sandbox`/`bridge`/`provision`/`version` + action `error`/`timeout`/`abort`) and `src/bridge.ts`. **Step 4: Run → pass. Step 5: Commit** `feat(stage): bridge transport with timeout/abort/typed errors`.

## P2-3: Sandbox runtime module (port + harden the spike runtime)

**Files:** Create `src/runtime/index.ts` (exports the runtime source string), `src/runtime/bootstrap.ts`, `tests/unit/runtime-build.test.ts`

- [ ] **Step 1: Write a failing test** asserting the built runtime source string contains the required capabilities (theme inject, `$state` bind, error boundary, dispatch, ResizeObserver) and is non-empty valid JS (e.g. `new Function(src)` does not throw at parse).
- [ ] **Step 2: Port `spike/stage-runtime.ts`** into `src/runtime/` as maintainable source (not one giant template) — build it to a string via esbuild/tsup at package-build time. Keep the proven behavior; add: `ui/update` apply (replace node by id / theme / state then re-render), and the approval-pending correlation (`ui/action-result` by `actionId`). **Step 3: Run → pass. Step 4: Commit** `feat(stage): sandbox runtime (theme/state/dispatch/error-boundary/update)`.

## P2-4: Shared-React delivery (resolves the ~200KB finding)

**Files:** Create `src/react-runtime.ts`, `tests/browser/react-shared.spec.ts`

- [ ] **Step 1: Write a failing Playwright test:** load a stage with TWO host bundles (both React-externalized); assert both render AND `window.__React` identity is shared (one React) — e.g. each bundle reports `React === window.__React`.
- [ ] **Step 2: Implement** `react-runtime.ts`: produce `blob:` ESM modules for `react` + `react-dom/client` (from Flowlet-bundled ESM React source delivered as data), inject an inline `<script type="importmap">` mapping the bare specifiers to those blobs, before importing host bundles. Build host bundles with React **external**. **Step 3: Run → pass** (or, if the import-map/blob path fails under CSP, fall back to bundled-React and record why — update the spec). **Step 4: Commit** `feat(stage): shared-React via blob ESM + import map`.

## P2-5: Stage host (framework-agnostic) — init/update/chokepoint/capability/pending

**Files:** Create `src/stage-host.ts`, `tests/unit/stage-host.test.ts`

- [ ] **Step 1: Write failing unit tests** (mock iframe `contentWindow` + postMessage): (a) `createStage` builds srcdoc with the CSP + `lang`/`title` (assert string contents); (b) `initStage` mints a per-node capability map and sends tokens in the tree; (c) a `tools/call` with a **valid** token + `originNodeId` reaches the `onAction` handler and maps to F1 `ActionResult`; (d) a `tools/call` with a **wrong/absent** token is rejected with a `capability` error and never calls `onAction`; (e) an `onAction` that returns `{ status: "pending" }` then later resolves causes a `ui/action-result` to be posted with the matching `actionId`.
- [ ] **Step 2: Run → fail. Step 3: Implement** `stage-host.ts` (port `spike/stage-host.ts` + the capability map, the `ActionRequest`/`ActionResult` mapping, `updateStage(iframe, update)`, and the approval-pending push). **Step 4: Run → pass. Step 5: Commit** `feat(stage): host init/update + capability validation + approval-pending`.

## P2-6: Real-browser CI tests (the spike's 8 gates, as shipped CI)

**Files:** Create `playwright.config.ts`, `tests/browser/*.spec.ts`, a tiny test host page/fixture under `tests/browser/fixtures/`

- [ ] **Step 1: Port the spike's 8 gate specs** into the package's `tests/browser/` against a fixture host page that uses the real `@flowlet/stage` API. **Strengthen the auto-size test** (assert height tracks a content change, per FINDINGS). Add a `ui/update` gate and a capability-rejection gate.
- [ ] **Step 2: Wire `pnpm --filter @flowlet/stage test:browser`** into the package scripts (separate from unit `test`, since it needs Chromium). **Step 3: Run → all green. Step 4: Commit** `test(stage): browser CI — 8 gates + update + capability + shared-React`.

## P2-7: Host build-step (externalize React, define NODE_ENV, stamp version)

**Files:** Create `packages/flowlet-stage/src/build/` (a Vite plugin **or** a thin CLI — pick Vite plugin; most hosts use Vite), `tests/unit/build-artifact.test.ts`

- [ ] **Step 1: Write a failing test** that runs the build helper on a sample presentational component and asserts the artifact: (a) does NOT contain a second React copy (externalized), (b) has `process.env.NODE_ENV` resolved (no bare `process` ref), (c) carries a version stamp. **Step 2: Implement** the Vite-plugin/preset (externalize `react`/`react-dom`, `define` NODE_ENV, emit a `version`). **Step 3: Run → pass. Step 4: Commit** `feat(stage): host build-step preset (externalize React + version stamp)`.

## P2-8: `flowlet-react` adapter + example wiring

**Files:** Create `packages/flowlet-react/src/stage-adapter.tsx`; modify `packages/flowlet-react/src/index.ts`, `packages/flowlet-react/src/stub-renderer.tsx` (replace), `examples/basic/*`; tests in `packages/flowlet-react`

- [ ] **Step 1: Write a failing test** (Testing Library + jsdom) asserting the adapter mounts a stage from `FlowletProvider` and forwards a `data-ui` node into `initStage` (mock `@flowlet/stage`'s host so jsdom doesn't need a real iframe). **Step 2: Implement** `stage-adapter.tsx` that depends on `@flowlet/stage`, replace `StubRenderer` usage with the real-boundary mount. Update `examples/basic` to render via the stage. **Step 3: Run → pass** (`pnpm --filter @flowlet/react test`). **Step 4: Commit** `feat(react): stage adapter replaces StubRenderer`.

## P2-9: Docs, cleanup, full-workspace green

- [ ] **Step 1:** Write `packages/flowlet-stage/README.md` (what it is, the `StageCapabilities` seam for F3b, the host build-step, the security model). Update `packages/flowlet-react/README.md`.
- [ ] **Step 2:** Delete `spike/` (it's served its purpose; FINDINGS + spec §12 capture the learnings). `git rm -r spike/`.
- [ ] **Step 3:** `pnpm typecheck && pnpm build && pnpm test` green across the whole workspace (turbo). Add the browser-test job to CI config if one exists.
- [ ] **Step 4: Commit** `docs(stage): readme + remove spike + workspace green`.

---

## Self-review (coverage map: spike findings + spec → tasks)

- Bridge transport (spec §4) + typed errors (§9) → P2-2. ✓
- Sandbox runtime: theme/state/dispatch/error-boundary/autosize/`ui/update` (§3/§5/§7) → P2-3. ✓
- Shared-React (FINDINGS #1, the ~200KB item) → P2-4. ✓
- Stage host: init/update + **capability mint/validate** (FINDINGS #4, §4) + **approval-pending** (FINDINGS #5, §4) + `ActionResult` mapping (FINDINGS #7) → P2-5. ✓
- Real-browser tests in shipped CI (§9) incl. strengthened auto-size (FINDINGS weak-spot) → P2-6. ✓
- Host build-step incl. **`process.env.NODE_ENV`** (FINDINGS #2) + version (§6) → P2-7. ✓
- `flowlet-react` adapter replacing `StubRenderer` (§8) → P2-8. ✓
- Package carved (§8), docs, spike removed, workspace green → P2-1, P2-9. ✓
- Decoupled from F2; built against F1 stub + frozen `DispatchAction` (§1). ✓

**Open for review:** the four design resolutions at the top (shared-React strategy, capability model, approval-pending shape, `ui/update` scope) — decided with recommendations, flag if any should change before execution.
