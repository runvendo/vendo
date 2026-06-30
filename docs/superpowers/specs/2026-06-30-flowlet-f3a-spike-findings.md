# F3a Spike — Findings

Throwaway spike validating the Flowlet F3a sandbox-runtime model before productizing. All 8 gates passed (10 Playwright tests green). This doc records what worked, how, and the surprises — input to Phase 2 and to the spec's frozen contracts.

## Gate results

| Gate | Result | Mechanism that worked |
|---|---|---|
| 1a · loads under CSP | PASS | `sandbox="allow-scripts"` (no `allow-same-origin`) srcdoc iframe; inline `type=module` bootstrap runs under `script-src 'unsafe-inline'`. |
| 1b · egress blocked | PASS | CSP `connect-src 'none'` blocks `fetch`; `img-src data:` blocks `new Image().src` to a remote host. Both probes report `blocked`. |
| 1c · bundle as data | PASS | Host fetches the pre-built ESM as text, passes it as `bundleSource`; the sandbox makes a `blob:` URL and `import()`s it (allowed by `script-src blob:`). No network load of code. |
| 2 · themed render | PASS | Brand tokens injected as `:root{--…}`; the host `Card` reads `var(--brand-primary)` → computed `rgb(0,170,119)`. |
| 3 · scoped state | PASS | A single whitelisted field in `params.state`, bound into props via a `{ $state: "key" }` reference resolved by `bindProps`. |
| 4 · action chokepoint | PASS | Declarative action descriptor in props → `window.__flowletDispatch(descriptor, originNodeId)` → `tools/call` postMessage carrying `originNodeId` (provenance) + `capability` + `payload` → host handler returns a result. |
| 5 · error isolation | PASS | Every node wrapped in its own React error boundary; a throwing `Boom` shows a contained `[data-error-boundary]` while its sibling `Card` still renders. |
| 6 · auto-size | PASS (weak test — see below) | `ResizeObserver` on `documentElement` posts `resize` height, debounced to >1px change; host applies it to `iframe.style.height`. |
| 7 · internal a11y | **GO** | axe-core run *inside* the sandbox document (via Playwright CDP `frame.evaluate`, which bypasses CSP); zero wcag2a/2aa violations (color-contrast excluded). |
| 8 · mixed tree | PASS | Prewired `__badge` + host `Card` + `generated` placeholder all render in the one stage. |

## Key findings (carry into Phase 2)

1. **React into the sandbox: self-contained bundle, single React on `window`.** Externalizing React + an import map pointing at `/node_modules` is **blocked by our CSP** (`script-src` allows only `'unsafe-inline' blob:`, not `'self'`/file URLs). So the spike bundles React *into* the host bundle and exposes `window.__React` / `window.__createRoot` for the runtime to reuse — exactly one React in the sandbox, avoiding the "two Reacts" hooks failure. **Cost: ~200 KB React per host bundle.** Phase 2 must decide the externalization strategy (e.g. a Flowlet-provided React delivered as a `blob:` ESM shim that both the runtime and the host bundle import) to avoid duplicating React per bundle.
2. **`process.env.NODE_ENV` must be defined at build time.** React's CJS source references `process.env.NODE_ENV`; the sandbox has no `process`, so the bundle throws `ReferenceError: process is not defined` unless the build sets `define: { 'process.env.NODE_ENV': '"production"' }` (or equivalent). Bake this into the host build-step contract.
3. **Bundle-as-data is the right model and it dovetails with the egress jail.** Because `connect-src 'none'` blocks network anyway, delivering the bundle as text → `blob:` import is both necessary (CSP) and sufficient (proven). This confirms the spec's "code crosses host→sandbox as data; sandbox→host stays data-only" invariant.
4. **The action `tools/call` is an explicit extension, as predicted.** `originNodeId` and `capability` ride in `params` alongside `name`/`payload` — they have no home in standard MCP `tools/call`. Confirmed: we borrow the JSON-RPC *framing convention*, not literal conformance. **`capability` was passed through but not minted/validated in the spike** — the host-mint/bind/expire transport-security model is a Phase-2 build item.
5. **Approval-pending was NOT exercised.** The spike's chokepoint resolves synchronously (`onAction` returns immediately). The spec's approval-pending model (dispatch resolves `pending`, the gated outcome reconciles via the agent stream — F1 §5.5) remains a Phase-2 design+build item. Flag clearly: the held-promise shape used in the spike is *not* the production shape for gated actions.
6. **Internal a11y is a GO.** The sandbox model does not structurally prevent WCAG 2.0/2.1 A/AA compliance. The only violations axe found were template gaps — missing `<html lang>` and `<title>` — fixed in the srcdoc. Cross-boundary a11y (coordinating focus/ARIA between host chrome and the stage) was NOT tested and remains the known-hard, not-yet-validated case.
7. **`ActionResult` shape needs a clean mapping in Phase 2.** The spike's host returns `{ result: "ok" }`, which `makeRpc` wraps again into `{ id, result: {...} }` — a benign double-wrap for the spike, but Phase 2 should map the chokepoint cleanly onto F1's `ActionResult = { result } | { error }`.

## Weak spots in the spike (strengthen in Phase 2 CI)

- **Auto-size test is trivially satisfied.** A browser's default iframe height (~150 px) already exceeds the test's `> 40` threshold and is stable, so the test passes even without the feature. The feature *is* wired (content-driven `scrollHeight`), but Phase 2's real-browser test should assert height ≈ content height and that it *tracks* a content change (e.g. add a node → height grows).
- **No `ui/update` / streaming.** The spike only does a single `ui/initialize` render. Replace-node-by-id, theme/state change, and partial/streaming updates were not exercised — they belong to the F3b renderer against the `subscribe` capability (which therefore stays *provisional* in the frozen interface).
- **Single host component shape.** Only a small presentational `Card`/`Badge`/`Row`/`Boom` set was used. The adaptation contract (presentational-only) is validated in principle but not against a real design-system component with many props/variants.

## What the spike froze

- The **stage-capability interface** F3b builds against (see spec §7, finalized).
- The **host-component adaptation contract** (see spec §6, finalized): presentational-only; inputs are (props, theme tokens, scoped state); interactivity via action descriptors; React bundled/externalized per finding #1.
- The **bridge conventions**: `ui/initialize` (host→sandbox), `tools/call` (sandbox→host chokepoint) over correlated JSON-RPC postMessage.
