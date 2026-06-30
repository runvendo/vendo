# @flowlet/stage

Secure sandboxed-stage runtime and bridge for agent-generated UI. Provides the host-side sandbox lifecycle (`createStage`, `connectStage`) and the Vite build preset (`flowletHostPreset`) that host bundles use.

## Security model

The stage runs in an opaque-origin `<iframe sandbox="allow-scripts">` using `srcdoc` — no `allow-same-origin`, so the sandbox cannot access host storage, cookies, or the DOM outside the frame. A strict CSP is set inline:

```
default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline';
img-src data:; font-src data:; connect-src 'none'
```

Key invariants:
- **Code crosses host → sandbox as data.** The bundle is fetched by the host and passed as text; the sandbox creates a `blob:` URL and `import()`s it. No network access from inside the sandbox (egress jail: `connect-src 'none'`).
- **Sandbox → host actions only through the audited chokepoint.** The sandbox calls `window.__flowletDispatch(descriptor, originNodeId)`, which serializes to a `tools/call` postMessage. The host validates, audits, and returns an `ActionResult`.
- **Bundle, theme tokens, and state projection are data.** They cross the postMessage boundary as structured-clone-safe values, not code.

## Public API

### `createStage(slot, opts?)`

Mounts a sandboxed `<iframe>` into `slot` (a host DOM element) and returns `{ iframe, endpoints }`. Optional `opts.reactSource` injects a React ESM shim so the sandbox shares a single React instance with the host bundle.

### `connectStage(endpoints, opts)`

Returns a `StageController` with:
- `ready: Promise<void>` — resolves when the sandbox runtime signals ready.
- `initialize(params)` — sends `ui/initialize` to the sandbox (theme, state, bundleSource, tree).
- `update(params)` — sends `ui/update` with a replacement node.
- `dispose()` — tears down the stage and removes the iframe.

### `StageController`

The object returned by `connectStage`. Exposes `ready`, `initialize`, `update`, and `dispose`.

### `StageCapabilities`

The interface F3b's renderer consumes (spec §7, frozen from the F3a spike):

```ts
interface StageCapabilities {
  resolveComponent(name: string, source: "prewired" | "host"): ComponentImpl | undefined;
  theme: ThemeTokens;
  getState(): Readonly<StateProjection>;
  subscribe(cb: () => void): () => void;   // provisional — not exercised in F3a
  dispatch(action: ActionRequest): Promise<ActionResult>;
}
```

## Host build step

Host component bundles must be built with `flowletHostPreset` from `@flowlet/stage/build`:

```ts
// vite.config.ts (host bundle)
import { flowletHostPreset } from "@flowlet/stage/build";

export default flowletHostPreset({
  entry: "src/entry.tsx",
  version: "1.0.0",
  outDir: "dist",
});
```

The preset encodes two hard requirements from the F3a spike:
1. React (`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) is externalized — the sandbox imports it from its import map, so there is exactly one React instance in the sandbox.
2. `process.env.NODE_ENV` is defined at build time — the sandbox has no `process` global and React throws without this.

It also stamps `__FLOWLET_BUNDLE_VERSION__` into the output for traceability.

Host component bundles must be **presentational only**: pure props in, action descriptors out. No network calls, no side effects that escape the sandbox.

`vite` and `@vitejs/plugin-react` are peer dependencies — the host project provides them.

## Running tests

Unit tests (19 cases, no browser needed):

```bash
pnpm --filter @flowlet/stage test
```

Browser tests (12 gates, requires Chromium via Playwright):

```bash
pnpm --filter @flowlet/stage test:browser
```
