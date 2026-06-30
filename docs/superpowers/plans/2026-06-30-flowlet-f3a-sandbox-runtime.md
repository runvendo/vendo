# Flowlet F3a — Sandbox runtime + bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the secure one-stage sandbox runtime + bridge for Flowlet's agent-generated UI, spike-first: prove the model's hard gates in a throwaway prototype, freeze the stage-capability interface, then productize.

**Architecture:** A single `sandbox="allow-scripts"` srcdoc iframe per agent surface, with an injected CSP that jails network egress. The host bundle (presentational components only) is delivered as data, not fetched. A thin MCP-Apps-shaped postMessage JSON-RPC bridge carries theme, scoped read-only state, and an audited action chokepoint. Phase 1 is a `spike/` prototype that validates 8 gates; Phase 2 carves the real `@flowlet/stage` package only after the gates pass.

**Tech Stack:** TypeScript, pnpm 9 workspaces, Turborepo, Vitest (unit), Playwright + axe-core (real-browser, the spike's actual tests), Vite (spike dev server + bundle build).

**Spec:** `docs/superpowers/specs/2026-06-30-flowlet-f3a-sandbox-runtime-design.md` (read it first — every task maps to a spec section).

---

## Phase structure & why

The spec is **spike-gated**: "if any gate fails, redesign before committing" (§2). Several productization details are explicitly *spike outputs* (build-step shape §6, bridge-lib decision §4, concrete `StageCapabilities` types §7). Writing full Phase-2 task code now would be guessing at outputs the spike produces. So:

- **Phase 1 (Tasks 1–11): the spike, in full detail.** Each gate is built and then validated by a Playwright assertion (the gates *are* the tests, per §2). Lives in root `spike/`, outside the pnpm workspace globs (`packages/*`, `examples/*`, `apps/*`), so it never enters the build graph and is genuinely throwaway.
- **Phase 2 (outline at the end): productize into `@flowlet/stage` + `flowlet-react`.** Gets expanded into bite-sized TDD tasks **after** the spike lands and the §7 interface + §6 adaptation contract are frozen. Do not start Phase 2 until Task 11 is done and the gates pass.

The spike code is throwaway; only its **findings**, the **frozen `StageCapabilities` interface**, and the **adaptation contract** carry forward.

---

## File structure (Phase 1 — the spike)

All under root `spike/` (a standalone Vite project, not a workspace member):

- `spike/package.json` — standalone deps (vite, playwright, @axe-core/playwright, react, react-dom). Installed with `--ignore-workspace`.
- `spike/vite.config.ts` — dev server; alias `@flowlet/core` → `../packages/flowlet-core/src` so the spike uses the real F1 types.
- `spike/host.html` + `spike/host.ts` — the host page that creates the Stage and drives it.
- `spike/stage-host.ts` — framework-agnostic: builds the srcdoc (CSP + bootstrap), creates the iframe, owns the host side of the bridge, terminates the action chokepoint.
- `spike/bridge.ts` — the MCP-Apps-shaped JSON-RPC framing: request/response correlation over postMessage. Shared shape used by both sides.
- `spike/stage-runtime.ts` — runs *inside* the iframe: bridge listener, loads the host bundle as data, resolves nodes, mounts, reports height, isolates throwing nodes.
- `spike/sample-bundle/` — a representative **presentational** design-system component (`Card`) + build script producing an ESM artifact with React externalized.
- `spike/types.ts` — spike-local: the node/theme/state/action shapes (re-using `@flowlet/core` `UINode`/`ActionRequest`).
- `spike/tests/*.spec.ts` — one Playwright spec per gate.
- `spike/FINDINGS.md` — written in Task 11, then folded into the spec.

---

## Task 1: Spike scaffold + dev server

**Files:**
- Create: `spike/package.json`, `spike/vite.config.ts`, `spike/host.html`, `spike/host.ts`, `spike/playwright.config.ts`, `spike/.gitignore`

- [ ] **Step 1: Create `spike/package.json`**

```json
{
  "name": "flowlet-f3a-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build:bundle": "vite build -c vite.bundle.config.ts",
    "test": "playwright test"
  },
  "devDependencies": {
    "@axe-core/playwright": "^4.10.0",
    "@playwright/test": "^1.48.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 2: Create `spike/.gitignore`**

```
node_modules
dist
test-results
playwright-report
```

- [ ] **Step 3: Create `spike/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@flowlet/core": fileURLToPath(new URL("../packages/flowlet-core/src", import.meta.url)),
    },
  },
  server: { port: 5180 },
});
```

- [ ] **Step 4: Create `spike/host.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>F3a spike host</title></head>
  <body>
    <h1>Flowlet F3a spike host</h1>
    <div id="stage-slot"></div>
    <script type="module" src="/host.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create a minimal `spike/host.ts` placeholder (filled in later tasks)**

```ts
// Driven by stage-host.ts in Task 2+. Placeholder so the dev server boots.
const slot = document.getElementById("stage-slot")!;
slot.textContent = "stage will mount here";
```

- [ ] **Step 6: Create `spike/playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  webServer: { command: "npm run dev", port: 5180, reuseExistingServer: true },
  use: { baseURL: "http://localhost:5180" },
});
```

- [ ] **Step 7: Install and verify the dev server boots**

Run:
```bash
cd spike && pnpm install --ignore-workspace && npx playwright install chromium && pnpm dev &
sleep 3 && curl -s http://localhost:5180/host.html | grep -q "spike host" && echo "DEV OK"; kill %1
```
Expected: prints `DEV OK`.

- [ ] **Step 8: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): scaffold vite + playwright host harness"
```

---

## Task 2: Stage host + srcdoc + CSP egress jail (Gate 1a: loads under CSP)

**Files:**
- Create: `spike/stage-host.ts`, `spike/stage-runtime.ts`, `spike/types.ts`, `spike/tests/gate1-load.spec.ts`
- Modify: `spike/host.ts`

- [ ] **Step 1: Create `spike/types.ts`**

```ts
import type { UINode, ActionRequest, ActionResult } from "@flowlet/core";
export type { UINode, ActionRequest, ActionResult };

export interface ThemeTokens { [cssVar: string]: string } // e.g. { "--brand-primary": "#0a7" }
export type StateProjection = Record<string, unknown>;      // scoped, structured-clone-safe only

export interface InitPayload {
  theme: ThemeTokens;
  state: StateProjection;
  bundleSource: string; // the host bundle ESM text, delivered as DATA (not a URL)
  tree: UINode;
}
```

- [ ] **Step 2: Write the failing test `spike/tests/gate1-load.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 1a: stage iframe boots under a strict CSP and reports ready", async ({ page }) => {
  await page.goto("/host.html");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.locator("#stage-root")).toBeVisible();
  await expect(page.locator("#stage-status")).toHaveText("ready");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate1-load.spec.ts`
Expected: FAIL — no `#flowlet-stage` iframe exists yet.

- [ ] **Step 4: Create `spike/stage-runtime.ts` (runs inside the iframe)**

```ts
// Serialized into the srcdoc as an inline module. Minimal for Gate 1: announce ready.
export const STAGE_RUNTIME_SRC = String.raw`
  const root = document.createElement("div");
  root.id = "stage-root";
  document.body.appendChild(root);
  parent.postMessage({ flowlet: true, type: "ready" }, "*");
`;
```

- [ ] **Step 5: Create `spike/stage-host.ts` (framework-agnostic host side)**

```ts
import { STAGE_RUNTIME_SRC } from "./stage-runtime";

// CSP that JAILS egress: no network connections, scripts only inline+blob, images only data:.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
].join("; ");

export function createStage(slot: HTMLElement): HTMLIFrameElement {
  const srcdoc = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}">
  </head><body><script type="module">${STAGE_RUNTIME_SRC}<\/script></body></html>`;

  const iframe = document.createElement("iframe");
  iframe.id = "flowlet-stage";
  iframe.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin -> opaque origin
  iframe.srcdoc = srcdoc;
  iframe.style.cssText = "width:100%;border:0;";
  slot.appendChild(iframe);
  return iframe;
}
```

- [ ] **Step 6: Update `spike/host.ts` to mount the stage and surface readiness**

```ts
import { createStage } from "./stage-host";

const slot = document.getElementById("stage-slot")!;
const status = document.createElement("div");
status.id = "stage-status";
status.textContent = "booting";
document.body.appendChild(status);

createStage(slot);
window.addEventListener("message", (e) => {
  if (e.data?.flowlet && e.data.type === "ready") status.textContent = "ready";
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate1-load.spec.ts`
Expected: PASS — iframe boots, `#stage-root` visible, status `ready`.

- [ ] **Step 8: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): stage host + srcdoc + CSP egress jail; gate 1a passes"
```

---

## Task 3: Prove egress is actually blocked (Gate 1b)

**Files:**
- Modify: `spike/stage-runtime.ts`
- Create: `spike/tests/gate1-egress.spec.ts`

- [ ] **Step 1: Write the failing test `spike/tests/gate1-egress.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 1b: network egress (fetch + image) is blocked by CSP", async ({ page }) => {
  await page.goto("/host.html");
  await expect(page.locator("#egress-fetch")).toHaveText("blocked");
  await expect(page.locator("#egress-img")).toHaveText("blocked");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate1-egress.spec.ts`
Expected: FAIL — no `#egress-*` indicators reported yet.

- [ ] **Step 3: Add egress probes to `spike/stage-runtime.ts`**

Append inside `STAGE_RUNTIME_SRC` (before the `ready` postMessage):

```js
  async function probeEgress() {
    let fetchResult = "allowed";
    try { await fetch("https://example.com/ping"); } catch { fetchResult = "blocked"; }
    const imgResult = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res("allowed");
      img.onerror = () => res("blocked");
      img.src = "https://example.com/x.png";
      setTimeout(() => res("blocked"), 1000);
    });
    parent.postMessage({ flowlet: true, type: "egress", fetchResult, imgResult }, "*");
  }
  probeEgress();
```

- [ ] **Step 4: Surface the egress results in `spike/host.ts`**

Add before the existing `message` listener body (extend the handler):

```ts
function ensure(id: string) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("div"); el.id = id; document.body.appendChild(el); }
  return el;
}
window.addEventListener("message", (e) => {
  if (!e.data?.flowlet) return;
  if (e.data.type === "egress") {
    ensure("egress-fetch").textContent = e.data.fetchResult;
    ensure("egress-img").textContent = e.data.imgResult;
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate1-egress.spec.ts`
Expected: PASS — both report `blocked`.

- [ ] **Step 6: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): prove fetch+image egress blocked under CSP; gate 1b passes"
```

---

## Task 4: Bridge (MCP-Apps-shaped JSON-RPC) + ui/initialize

**Files:**
- Create: `spike/bridge.ts`
- Modify: `spike/stage-host.ts`, `spike/stage-runtime.ts`, `spike/host.ts`
- Create: `spike/tests/gate-bridge.spec.ts`

- [ ] **Step 1: Create `spike/bridge.ts` (correlation + framing, both sides)**

```ts
// MCP-Apps-shaped: JSON-RPC-style { id, method, params } / { id, result|error }.
export interface RpcRequest { flowlet: true; id: string; method: string; params?: unknown }
export interface RpcResponse { flowlet: true; id: string; result?: unknown; error?: { code: string; message: string } }

export function makeRpc(target: Window, onRequest?: (method: string, params: unknown) => Promise<unknown>) {
  const pending = new Map<string, (r: RpcResponse) => void>();
  let seq = 0;

  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg?.flowlet) return;
    if ("method" in msg && onRequest) {
      try { target.postMessage({ flowlet: true, id: msg.id, result: await onRequest(msg.method, msg.params) }, "*"); }
      catch (err) { target.postMessage({ flowlet: true, id: msg.id, error: { code: "handler", message: String(err) } }, "*"); }
    } else if ("id" in msg && pending.has(msg.id)) {
      pending.get(msg.id)!(msg as RpcResponse); pending.delete(msg.id);
    }
  });

  return {
    call(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
      const id = `rpc-${seq++}`;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
        pending.set(id, (r) => { clearTimeout(t); r.error ? reject(new Error(r.error.message)) : resolve(r.result); });
        target.postMessage({ flowlet: true, id, method, params } satisfies RpcRequest, "*");
      });
    },
  };
}
```

- [ ] **Step 2: Write the failing test `spike/tests/gate-bridge.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("bridge: host ui/initialize reaches the runtime and is acknowledged", async ({ page }) => {
  await page.goto("/host.html");
  await expect(page.locator("#init-ack")).toHaveText("initialized");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate-bridge.spec.ts`
Expected: FAIL — no `#init-ack`.

- [ ] **Step 4: Wire `ui/initialize` in `spike/stage-runtime.ts`**

Replace the `ready` postMessage with a bridge handler. Append to `STAGE_RUNTIME_SRC`:

```js
  // inline copy of makeRpc (the spike runtime can't import; productize will bundle it)
  ${/* keep in sync with bridge.ts */ ""}
  const pending = new Map(); let seq = 0;
  window.addEventListener("message", async (e) => {
    const m = e.data; if (!m || !m.flowlet) return;
    if (m.method === "ui/initialize") {
      window.__flowletInit = m.params;
      parent.postMessage({ flowlet: true, id: m.id, result: { ok: true } }, "*");
      parent.postMessage({ flowlet: true, type: "init-ack" }, "*");
    }
  });
  parent.postMessage({ flowlet: true, type: "ready" }, "*");
```

- [ ] **Step 5: Send `ui/initialize` from `spike/stage-host.ts`**

Add an exported `initStage` that, once the iframe signals `ready`, calls the bridge:

```ts
import { makeRpc, type RpcRequest } from "./bridge";
import type { InitPayload } from "./types";

export function initStage(iframe: HTMLIFrameElement, payload: InitPayload) {
  const rpc = makeRpc(iframe.contentWindow!);
  return rpc.call("ui/initialize", payload);
}
```

- [ ] **Step 6: Drive init from `spike/host.ts`**

Extend the message handler: on `ready`, call `initStage` with a minimal payload; on `init-ack`, surface it.

```ts
import { initStage } from "./stage-host";
// ...inside the message listener:
  if (e.data.type === "ready") {
    const iframe = document.getElementById("flowlet-stage") as HTMLIFrameElement;
    initStage(iframe, { theme: {}, state: {}, bundleSource: "", tree: { id: "root", kind: "generated", payload: null } });
  }
  if (e.data.type === "init-ack") ensure("init-ack").textContent = "initialized";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate-bridge.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): MCP-Apps-shaped bridge + ui/initialize round-trip"
```

---

## Task 5: Sample presentational bundle loads as data + renders themed (Gates 1c, 2)

**Files:**
- Create: `spike/sample-bundle/Card.tsx`, `spike/sample-bundle/entry.tsx`, `spike/vite.bundle.config.ts`
- Modify: `spike/stage-runtime.ts`, `spike/host.ts`
- Create: `spike/tests/gate2-render.spec.ts`

- [ ] **Step 1: Create `spike/sample-bundle/Card.tsx` (presentational; theme via CSS vars)**

```tsx
import React from "react";
// Presentational ONLY: pure function of props. No fetch/route/store. Theme via CSS vars.
export function Card({ title, body }: { title: string; body: string }) {
  return (
    <div data-testid="host-card" style={{ background: "var(--brand-surface)", color: "var(--brand-text)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ color: "var(--brand-primary)" }}>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
```

- [ ] **Step 2: Create `spike/sample-bundle/entry.tsx` (registers impls by name)**

```tsx
import { Card } from "./Card";
// The bundle exposes a global registry keyed by component name.
(globalThis as any).__FLOWLET_HOST__ = { Card };
```

- [ ] **Step 3: Create `spike/vite.bundle.config.ts` (single ESM, React externalized)**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: "sample-bundle/entry.tsx", formats: ["es"], fileName: () => "host-bundle.js" },
    rollupOptions: { external: ["react", "react-dom", "react/jsx-runtime"] },
    outDir: "sample-bundle/dist",
  },
});
```

- [ ] **Step 4: Build the bundle**

Run: `cd spike && pnpm build:bundle && test -f sample-bundle/dist/host-bundle.js && echo "BUNDLE OK"`
Expected: prints `BUNDLE OK`.

- [ ] **Step 5: Write the failing test `spike/tests/gate2-render.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 1c+2: host bundle loads as data and renders with injected theme", async ({ page }) => {
  await page.goto("/host.html?case=card");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("host-card")).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Hello" })).toBeVisible();
  // theme applied: heading uses --brand-primary
  const color = await frame.getByRole("heading", { name: "Hello" }).evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe("rgb(0, 170, 119)"); // #00aa77
});
```

- [ ] **Step 6: Load the bundle-as-data + render in `spike/stage-runtime.ts`**

The runtime must: inject theme vars, import the bundle from a `blob:` URL (data, CSP-allowed via `blob:`), mount React, resolve `component` nodes against `__FLOWLET_HOST__`. Replace the runtime body with a fuller version that, on `ui/initialize`:

```js
  function injectTheme(theme) {
    const style = document.createElement("style");
    style.textContent = ":root{" + Object.entries(theme).map(([k,v]) => k+":"+v).join(";") + "}";
    document.head.appendChild(style);
  }
  async function loadBundle(src) {
    if (!src) return {};
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await import(/* @vite-ignore */ url);  // executes; registers globalThis.__FLOWLET_HOST__
    return (globalThis.__FLOWLET_HOST__) || {};
  }
  async function render(params) {
    injectTheme(params.theme || {});
    const host = await loadBundle(params.bundleSource);
    const React = window.__React, createRoot = window.__createRoot; // provided via import map (step 7)
    function resolve(name) { return host[name]; }
    function toElement(node) {
      if (node.kind === "component") {
        const Impl = resolve(node.name);
        if (!Impl) return React.createElement("div", { "data-error": "unknown:" + node.name });
        return React.createElement(Impl, node.props || {});
      }
      return React.createElement("div", { "data-generated": true }, "[generated]");
    }
    createRoot(document.getElementById("stage-root")).render(toElement(params.tree));
  }
```

and call `render(m.params)` in the `ui/initialize` handler (after the ack).

- [ ] **Step 7: Provide React inside the sandbox via an import map in the srcdoc**

In `spike/stage-host.ts`, the React the bundle externalizes must exist in the sandbox. Add React/ReactDOM as data-URL modules via an import map, and expose them on `window`. Update the srcdoc head:

```ts
// In createStage, build data-URL modules for react/react-dom from the spike's own copies,
// then add an import map + a tiny loader. (The spike reads them at dev time via /node_modules.)
const importMap = `<script type="importmap">${JSON.stringify({
  imports: { react: "/node_modules/react/umd/react.development.js", "react-dom/client": "/node_modules/react-dom/umd/react-dom.development.js" }
})}<\/script>`;
```

> NOTE: getting React into an opaque-origin + `connect-src 'none'` frame is exactly a spike unknown (§6 React externalization). If the import-map/data-URL path is blocked by CSP, fall back to **inlining React's UMD source directly into the srcdoc** as data (proves the "everything as data" model). Record which path worked in FINDINGS.md.

- [ ] **Step 8: Add the `?case=card` payload in `spike/host.ts`**

When the URL has `case=card`, initialize with the built bundle text (fetched at dev time from `/sample-bundle/dist/host-bundle.js`), theme `{ "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }`, and tree `{ id:"c1", kind:"component", source:"host", name:"Card", props:{ title:"Hello", body:"World" } }`.

```ts
const params = new URLSearchParams(location.search);
async function payloadFor(kind: string) {
  if (kind === "card") {
    const bundleSource = await (await fetch("/sample-bundle/dist/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }, state: {},
      bundleSource, tree: { id: "c1", kind: "component", source: "host", name: "Card", props: { title: "Hello", body: "World" } } };
  }
  return { theme: {}, state: {}, bundleSource: "", tree: { id: "root", kind: "generated", payload: null } };
}
// in the ready handler: initStage(iframe, await payloadFor(params.get("case") || ""))
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate2-render.spec.ts`
Expected: PASS — card visible, heading themed to `rgb(0, 170, 119)`.

- [ ] **Step 10: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): presentational host bundle loads as data + renders themed; gates 1c,2 pass"
```

---

## Task 6: Scoped state projection readable (Gate 3)

**Files:**
- Modify: `spike/sample-bundle/Card.tsx`, `spike/stage-runtime.ts`, `spike/host.ts`
- Create: `spike/tests/gate3-state.spec.ts`

- [ ] **Step 1: Make `Card` read a scoped-state value via a prop fed from the projection**

Extend `Card` to accept `accountName?: string` and render it in a `data-testid="card-account"` span. Rebuild the bundle (`pnpm build:bundle`).

```tsx
{props.accountName ? <span data-testid="card-account">{props.accountName}</span> : null}
```

- [ ] **Step 2: Write the failing test `spike/tests/gate3-state.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 3: a scoped state value is projected in and rendered", async ({ page }) => {
  await page.goto("/host.html?case=state");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("card-account")).toHaveText("Checking ****1234");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate3-state.spec.ts`
Expected: FAIL — no `state` case yet.

- [ ] **Step 4: Make the runtime expose state to node props via a `$state` reference**

In `toElement`, before creating a component element, resolve any prop value of the form `{ $state: "key" }` against `params.state`:

```js
      function bindProps(props, state) {
        const out = {};
        for (const [k, v] of Object.entries(props || {}))
          out[k] = (v && typeof v === "object" && "$state" in v) ? state[v.$state] : v;
        return out;
      }
```
Use `bindProps(node.props, params.state)` instead of `node.props`.

- [ ] **Step 5: Add the `?case=state` payload in `spike/host.ts`**

Scoped projection only — a single whitelisted field, not the whole app state:

```ts
  if (kind === "state") {
    const bundleSource = await (await fetch("/sample-bundle/dist/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" },
      state: { accountName: "Checking ****1234" }, bundleSource,
      tree: { id: "c1", kind: "component", source: "host", name: "Card",
        props: { title: "Acct", body: "x", accountName: { $state: "accountName" } } } };
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate3-state.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): scoped state projection bound into props; gate 3 passes"
```

---

## Task 7: Interactive callback round-trips as an action descriptor (Gate 4)

**Files:**
- Modify: `spike/sample-bundle/Card.tsx`, `spike/stage-runtime.ts`, `spike/stage-host.ts`, `spike/host.ts`
- Create: `spike/tests/gate4-action.spec.ts`

- [ ] **Step 1: Add an action-descriptor button to `Card`**

A button whose handler calls a runtime-provided `__dispatch` with the descriptor from props (functions can't cross the bridge; descriptors do). Rebuild the bundle.

```tsx
{props.action ? (
  <button data-testid="card-btn" onClick={() => (globalThis as any).__flowletDispatch(props.action, props.__nodeId)}>
    {props.action.label}
  </button>
) : null}
```

- [ ] **Step 2: Write the failing test `spike/tests/gate4-action.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 4: a button action round-trips through the chokepoint with provenance", async ({ page }) => {
  await page.goto("/host.html?case=action");
  const frame = page.frameLocator("#flowlet-stage");
  await frame.getByTestId("card-btn").click();
  await expect(page.locator("#action-log")).toHaveText("origin=c1 action=confirm result=ok");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate4-action.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `__flowletDispatch` in the runtime → bridge → host chokepoint**

In the runtime, define `globalThis.__flowletDispatch` to send a `tools/call`-style request carrying `originNodeId` (provenance) + `action` + `payload`, and reflect the result. Pass `__nodeId` into each component's props in `toElement` (`out.__nodeId = node.id`).

```js
  globalThis.__flowletDispatch = async (descriptor, originNodeId) => {
    const id = "act-" + Math.random().toString(36).slice(2);
    const result = await new Promise((resolve) => {
      const handler = (e) => { if (e.data?.flowlet && e.data.id === id) { window.removeEventListener("message", handler); resolve(e.data.result); } };
      window.addEventListener("message", handler);
      parent.postMessage({ flowlet: true, id, method: "tools/call",
        params: { name: descriptor.action, originNodeId, capability: window.__flowletInit?.capability, payload: descriptor.payload } }, "*");
    });
    return result;
  };
```

- [ ] **Step 5: Terminate the chokepoint in `spike/stage-host.ts`**

`initStage` registers an `onRequest` handler for `tools/call` that validates provenance, logs, and returns a result. Update `makeRpc(iframe.contentWindow!, onRequest)`:

```ts
export function initStage(iframe: HTMLIFrameElement, payload: InitPayload, onAction?: (req: any) => Promise<any>) {
  const rpc = makeRpc(iframe.contentWindow!, async (method, params) => {
    if (method === "tools/call") return onAction ? onAction(params) : { error: "no handler" };
    throw new Error("unknown method " + method);
  });
  return rpc.call("ui/initialize", payload);
}
```

- [ ] **Step 6: Add the `?case=action` payload + action log in `spike/host.ts`**

```ts
  if (kind === "action") {
    const bundleSource = await (await fetch("/sample-bundle/dist/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }, state: {}, bundleSource,
      tree: { id: "c1", kind: "component", source: "host", name: "Card",
        props: { title: "Confirm?", body: "x", action: { action: "confirm", label: "Confirm", payload: { amount: 10 } } } } };
  }
// in ready handler, pass onAction:
//   initStage(iframe, await payloadFor(...), async (req) => {
//     ensure("action-log").textContent = `origin=${req.originNodeId} action=${req.name} result=ok`;
//     return { result: "ok" };
//   });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate4-action.spec.ts`
Expected: PASS — `origin=c1 action=confirm result=ok`.

- [ ] **Step 8: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): callbacks-as-action-descriptors round-trip via chokepoint; gate 4 passes"
```

---

## Task 8: A throwing node is isolated (Gate 5)

**Files:**
- Modify: `spike/stage-runtime.ts`, `spike/host.ts`
- Create: `spike/tests/gate5-isolation.spec.ts`

- [ ] **Step 1: Write the failing test `spike/tests/gate5-isolation.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 5: one throwing node does not take down the rest of the stage", async ({ page }) => {
  await page.goto("/host.html?case=throw");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("host-card")).toBeVisible();          // sibling survived
  await expect(frame.locator('[data-error-boundary]')).toHaveText(/render error/); // bad node contained
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate5-isolation.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Wrap each node in a React error boundary in the runtime**

Add a minimal class error boundary and wrap every element produced by `toElement`. Support a tree with `children` so a sibling can survive a throwing node:

```js
  class EB extends React.Component {
    constructor(p){ super(p); this.state = { err: false }; }
    static getDerivedStateFromError(){ return { err: true }; }
    render(){ return this.state.err ? React.createElement("div", { "data-error-boundary": true }, "render error") : this.props.children; }
  }
  function wrap(node){ return React.createElement(EB, { key: node.id }, toElement(node)); }
  // toElement: for a "component" named "Boom", render a component that throws; render children via wrap()
```
Render the root's children with `wrap` so siblings are independent.

- [ ] **Step 4: Add the `?case=throw` payload in `spike/host.ts`**

A root with two children: a `Boom` component (throws) and a normal `Card`.

```ts
  if (kind === "throw") {
    const bundleSource = await (await fetch("/sample-bundle/dist/host-bundle.js")).text();
    return { theme: { "--brand-primary": "#00aa77", "--brand-surface": "#fff", "--brand-text": "#111" }, state: {}, bundleSource,
      tree: { id: "root", kind: "component", source: "prewired", name: "__row", props: {}, children: [
        { id: "bad", kind: "component", source: "host", name: "Boom", props: {} },
        { id: "good", kind: "component", source: "host", name: "Card", props: { title: "OK", body: "survived" } },
      ] } };
  }
```
Add a `Boom` (throws) and a `__row` (renders children) to the sample bundle entry; rebuild.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate5-isolation.spec.ts`
Expected: PASS — card visible, error boundary contained.

- [ ] **Step 6: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): per-node error boundary isolates throwing node; gate 5 passes"
```

---

## Task 9: Iframe auto-sizes without oscillation (Gate 6)

**Files:**
- Modify: `spike/stage-runtime.ts`, `spike/stage-host.ts`, `spike/host.ts`
- Create: `spike/tests/gate6-autosize.spec.ts`

- [ ] **Step 1: Write the failing test `spike/tests/gate6-autosize.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 6: iframe height tracks content and stabilizes", async ({ page }) => {
  await page.goto("/host.html?case=card");
  const iframe = page.locator("#flowlet-stage");
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.height)).toBeGreaterThan(40);
  const h1 = (await iframe.boundingBox())!.height;
  await page.waitForTimeout(300);
  const h2 = (await iframe.boundingBox())!.height;
  expect(Math.abs(h1 - h2)).toBeLessThan(2); // stable, no oscillation
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd spike && pnpm test tests/gate6-autosize.spec.ts`
Expected: FAIL — iframe has no auto-height yet.

- [ ] **Step 3: Report height from the runtime via ResizeObserver**

Append to the runtime (after render): observe `document.documentElement`, post height; debounce to avoid oscillation:

```js
  let lastH = 0;
  const ro = new ResizeObserver(() => {
    const h = document.documentElement.scrollHeight;
    if (Math.abs(h - lastH) > 1) { lastH = h; parent.postMessage({ flowlet: true, type: "resize", height: h }, "*"); }
  });
  ro.observe(document.documentElement);
```

- [ ] **Step 4: Apply height in `spike/host.ts`**

```ts
  if (e.data.type === "resize") {
    const iframe = document.getElementById("flowlet-stage") as HTMLIFrameElement;
    iframe.style.height = e.data.height + "px";
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd spike && pnpm test tests/gate6-autosize.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): debounced ResizeObserver auto-size; gate 6 passes"
```

---

## Task 10: Internal accessibility go/no-go (Gate 7) + mixed tree (Gate 8)

**Files:**
- Create: `spike/tests/gate7-a11y.spec.ts`, `spike/tests/gate8-mixed.spec.ts`
- Modify: `spike/host.ts` (add `?case=mixed`)

- [ ] **Step 1: Write the a11y assessment `spike/tests/gate7-a11y.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("gate 7: a self-contained stage has no critical a11y violations", async ({ page }) => {
  await page.goto("/host.html?case=action");
  const results = await new AxeBuilder({ page })
    .include("#flowlet-stage")
    .options({ runOnly: ["wcag2a", "wcag2aa"] })
    .analyze();
  const critical = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  // GO/NO-GO: record violations in FINDINGS; fail only on critical so the gate is honest.
  expect(critical, JSON.stringify(critical, null, 2)).toHaveLength(0);
});
```

- [ ] **Step 2: Run it; record the result**

Run: `cd spike && pnpm test tests/gate7-a11y.spec.ts`
Expected: PASS (no critical/serious) → internal-a11y is a GO. If it FAILS with structural violations that can't be fixed inside one document, that is the **escalation signal against F1 decision #4** — stop and record in FINDINGS.md before continuing.

- [ ] **Step 3: Write the mixed-tree test `spike/tests/gate8-mixed.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("gate 8: prewired + host + generated nodes coexist in one stage", async ({ page }) => {
  await page.goto("/host.html?case=mixed");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("host-card")).toBeVisible();       // host
  await expect(frame.locator("[data-generated]")).toBeVisible();     // generated placeholder
  await expect(frame.locator("[data-prewired]")).toBeVisible();      // prewired primitive
});
```

- [ ] **Step 4: Add the `?case=mixed` payload + a prewired primitive**

Add a `__badge` prewired primitive (renders `[data-prewired]`) to the sample bundle entry; rebuild. Add the `mixed` case in `host.ts` with a `__row` root containing a prewired `__badge`, a host `Card`, and a `generated` node.

- [ ] **Step 5: Run both tests to verify they pass**

Run: `cd spike && pnpm test tests/gate7-a11y.spec.ts tests/gate8-mixed.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the FULL gate suite**

Run: `cd spike && pnpm test`
Expected: all 8 gates PASS.

- [ ] **Step 7: Commit**

```bash
git add spike/ && git commit -m "spike(f3a): internal a11y go/no-go + mixed tree; all 8 gates pass"
```

---

## Task 11: Findings + freeze the stage-capability interface + adaptation contract

**Files:**
- Create: `spike/FINDINGS.md`
- Modify: `docs/superpowers/specs/2026-06-30-flowlet-f3a-sandbox-runtime-design.md` (append a "Spike findings" section; finalize §7 types + §6 adaptation contract)

- [ ] **Step 1: Write `spike/FINDINGS.md`** — for each of the 8 gates: pass/fail, the mechanism that worked, and surprises. Explicitly record: (a) how React got into the sandbox (import-map vs inlined-as-data), (b) whether `connect-src 'none'` blocked anything needed, (c) the a11y result (GO/NO-GO + violation list), (d) the build-step mechanism for the host bundle (externalization), (e) bridge-lib decision (thin layer vs ext-apps).

- [ ] **Step 2: Finalize the `StageCapabilities` interface (§7) from what the spike actually needed**

Append concrete types to the spec, replacing the "illustrative/provisional" note. Base it on the real spike surface: `resolveComponent`, `theme`, `getState`, `subscribe`, `dispatch` (with the `tools/call` params actually used: `name`, `originNodeId`, `capability`, `payload`), and the `$state` prop-binding + action-descriptor conventions that emerged.

- [ ] **Step 3: Finalize the host-component adaptation contract (§6)**

From Task 5's experience, write the concrete rules: presentational-only; props/theme/scoped-state inputs; interactivity via action descriptors; React externalized; how a connected component is adapted (lift data/actions to props).

- [ ] **Step 4: Commit**

```bash
git add spike/FINDINGS.md docs/superpowers/specs/2026-06-30-flowlet-f3a-sandbox-runtime-design.md
git commit -m "spike(f3a): findings + freeze StageCapabilities + adaptation contract"
```

- [ ] **Step 5: GATE — review before Phase 2**

If any spike gate failed (esp. Gate 1b egress, Gate 7 a11y), STOP and revise the spec (§2 redesign rule) before planning Phase 2. If all pass, expand Phase 2 below into bite-sized tasks using the frozen interface.

---

## Phase 2 — Productize into `@flowlet/stage` + `flowlet-react` (planned after the spike)

> Do NOT start until Task 11 is complete and all 8 gates pass. These are outline-level; each becomes bite-sized TDD tasks once the §7 interface and §6 contract are frozen by the spike. Phase 2 is real, shipped code (TDD, Vitest + Playwright-in-CI), re-implementing the validated spike — not a copy of the throwaway.

- **P2-1: Carve `@flowlet/stage` package.** `packages/flowlet-stage` with `package.json` (depends on `@flowlet/core`), `tsconfig`, `vitest.config`, build via tsc. Add to workspace; `pnpm build` green.
- **P2-2: Bridge transport (TDD, Vitest + mock postMessage).** Port the spike `bridge.ts` as production code: request/response correlation, timeout, abort, error taxonomy (`bridge` error code). Unit tests against a mock postMessage pair.
- **P2-3: Stage host (framework-agnostic).** `createStage` + CSP egress jail + `srcdoc`; `ui/initialize` / `ui/update`; chokepoint termination mapping to F1 `ActionRequest`/`ActionResult`; capability validation (host-mint/bind/expire, the transport-security model from §4); approval-**pending** dispatch (resolve `pending`, reconcile via stream).
- **P2-4: Sandbox stage runtime + bootstrap.** The inner bundle (externalized React): bridge listener, bundle-as-data loader (the path the spike proved), theme injection, `$state` binding, action-descriptor dispatch, per-node error-boundary hook, ResizeObserver auto-size. Expose `StageCapabilities` for F3b's renderer to mount against; ship the minimal stub mount that replaces F1 `StubRenderer`.
- **P2-5: Real-browser CI tests (Playwright + axe) in `@flowlet/stage`.** Bundle-load-as-data under CSP, **egress blocked**, action round-trip, auto-size, throwing-node isolation, internal a11y. These are the highest-risk behaviors and MUST live in shipped CI, not just the spike.
- **P2-6: Host build-step.** The CLI/Vite-plugin shape the spike chose: compile presentational components + externalize React + stamp a version; a build-artifact test asserts externalization + version.
- **P2-7: React adapter in `flowlet-react`.** Thin: mount `@flowlet/stage` from `FlowletProvider`, replace `StubRenderer`. Update `flowlet-react` tests; example app (`examples/basic`) wires the real stage.
- **P2-8: Docs + cleanup.** Update package READMEs; delete `spike/`; ensure `pnpm typecheck && build && test` green across the workspace.

---

## Self-review notes (coverage map spec → tasks)

- §2 spike gates 1–8 → Tasks 2–10 (1a/1b Tasks 2–3, 1c/2 Task 5, 3 Task 6, 4 Task 7, 5 Task 8, 6 Task 9, 7/8 Task 10). ✓
- §3 one stage + CSP + framework-agnostic host → Tasks 2, P2-3. ✓
- §4 bridge conventions, callbacks-as-descriptors, approval-pending, capability transport, error/timeout/abort → Tasks 4,7 + P2-2,P2-3. ✓
- §5 theme + scoped state + serialization + font-as-data → Tasks 5,6 + P2-4. ✓
- §6 presentational-only provisioning, bundle-as-data, React externalization, versioning, adaptation contract → Tasks 5,11 + P2-4,P2-6. ✓
- §7 StageCapabilities frozen from real use; render/lifecycle/error-isolation surfaced for F3b → Tasks 8,11 + P2-4. ✓
- §8 package carved after spike → P2-1. ✓
- §9 egress CSP, errors, real-browser tests in shipped CI → Tasks 3,8 + P2-5. ✓
- §10/§11 risks/open-Qs → resolved in FINDINGS (Task 11). ✓
```
