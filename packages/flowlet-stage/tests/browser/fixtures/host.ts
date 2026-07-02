import { createStage, connectStage, createGenUISession } from "@flowlet/stage";
import type { StageInitPayload } from "@flowlet/stage";
import type { GeneratedPayload } from "@flowlet/core";

// ── DOM scaffolding ───────────────────────────────────────────────────────────

const slot = document.getElementById("stage-slot")!;

const statusEl = document.createElement("div");
statusEl.id = "stage-status";
statusEl.textContent = "booting";
document.body.appendChild(statusEl);

const params = new URLSearchParams(location.search);
const caseParam = params.get("case") ?? "";

function ensure(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

// ── Create + connect stage ────────────────────────────────────────────────────
//
// For the "shared-react" case we pre-fetch the React shim and pass it to
// createStage() so it can be embedded in the srcdoc before the module runtime
// executes.  For all other cases reactSource is undefined and the existing
// self-contained bundle path is used unchanged.

const NEEDS_REACT_SHIM = new Set(["shared-react", "gen-code", "gen-code-error", "gen-jsx", "mixed", "real-bundle"]);
const reactSource = NEEDS_REACT_SHIM.has(caseParam)
  ? await fetch("/flowlet-react-runtime.js").then((r) => r.text())
  : undefined;

const { iframe, endpoints } = createStage(slot, { reactSource });

const controller = connectStage(endpoints, {
  onAction: async (req) => {
    ensure("action-log").textContent =
      `origin=${req.originNodeId} action=${req.action} result=ok`;
    return { result: "ok" };
  },
});

// Expose controller globally so specs can drive controller.update() etc.
(window as any).__controller = controller;

// ── Payload factory ───────────────────────────────────────────────────────────

async function payloadFor(kind: string): Promise<StageInitPayload> {
  async function bundle(): Promise<string> {
    return fetch("/host-bundle.js").then((r) => r.text());
  }

  async function bundleExt(): Promise<string> {
    return fetch("/host-bundle-ext.js").then((r) => r.text());
  }

  const theme = {
    "--flowlet-accent": "#00aa77",
    "--flowlet-surface": "#fff",
    "--flowlet-fg": "#111",
    // Distinctive first family so the baseline-styles gate can assert the
    // sandbox body actually inherits the brand font (not the UA serif default).
    "--flowlet-font": "TestBrandFont, sans-serif",
  };

  if (kind === "real-bundle") {
    // The REAL @flowlet/components sandbox bundle (copied from its dist-sandbox
    // by the test:browser pre-step). Regression gate for the shim-exports P0:
    // the externalized bundle's static named imports ({ PureComponent, … } from
    // "react", { createPortal } from "react-dom") must link against the shim,
    // and the bundle must carry OpenUI's base CSS so catalog components render
    // styled, not as bare HTML.
    return {
      theme,
      state: {},
      bundleSource: await fetch("/components-sandbox.js").then((r) => {
        if (!r.ok) throw new Error("components-sandbox.js missing — run the test:browser pre-step");
        return r.text();
      }),
      componentTheme: { theme: {}, mode: "light" },
      tree: {
        id: "c1",
        kind: "component",
        source: "prewired",
        name: "Card",
        props: { title: "Real Bundle", body: "catalog card" },
      },
    };
  }

  if (kind === "card") {
    return {
      theme,
      state: {},
      bundleSource: await bundle(),
      tree: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "Hello", body: "World" },
      },
    };
  }

  if (kind === "theme-vars") {
    // Regression guard for silent theme-var drop: inject a DISTINCTIVE
    // --flowlet-accent and render a component that reads it. The spec asserts the
    // computed color equals the injected brand value (not a hardcoded fallback),
    // proving injected brand vars actually theme the sandboxed component.
    return {
      theme: {
        "--flowlet-accent": "#ff00aa",
        "--flowlet-surface": "#fff",
        "--flowlet-fg": "#111",
      },
      state: {},
      bundleSource: await bundle(),
      tree: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "Themed", body: "x" },
      },
    };
  }

  if (kind === "component-theme" || kind === "component-theme-none") {
    // TU-3 end-to-end (sample wrapper): the runtime mounts the bundle-supplied
    // __FLOWLET_THEME_WRAP__ around the tree ONLY when the init payload carries a
    // componentTheme. ThemeProbe reads blob.marker out of that wrap's context.
    //   - "component-theme":      componentTheme present → probe renders the marker
    //   - "component-theme-none": componentTheme absent  → wrap is a no-op (empty)
    return {
      theme,
      state: {},
      bundleSource: await bundle(),
      ...(kind === "component-theme" ? { componentTheme: { marker: "themed-ok" } } : {}),
      tree: {
        id: "root",
        kind: "component",
        source: "host",
        name: "ThemeProbe",
        props: {},
      },
    };
  }

  if (kind === "action") {
    return {
      theme,
      state: {},
      bundleSource: await bundle(),
      tree: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: {
          title: "Confirm?",
          body: "x",
          action: { action: "confirm", label: "Confirm", payload: { amount: 10 } },
        },
      },
    };
  }

  if (kind === "state") {
    return {
      theme,
      state: { accountName: "Checking ****1234" },
      bundleSource: await bundle(),
      tree: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "Acct", body: "x", accountName: { $state: "accountName" } },
      },
    };
  }

  if (kind === "throw") {
    return {
      theme,
      state: {},
      bundleSource: await bundle(),
      tree: {
        id: "root",
        kind: "component",
        source: "prewired",
        name: "__row",
        props: {},
        children: [
          { id: "bad", kind: "component", source: "host", name: "Boom", props: {} },
          {
            id: "good",
            kind: "component",
            source: "host",
            name: "Card",
            props: { title: "OK", body: "survived" },
          },
        ],
      },
    };
  }

  if (kind === "update") {
    return {
      theme,
      state: {},
      bundleSource: await bundle(),
      tree: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "Before", body: "initial content" },
      },
    };
  }

  if (kind === "shared-react") {
    // Use the externalized bundle; React comes from the import map shim.
    return {
      theme,
      state: {},
      bundleSource: await bundleExt(),
      tree: {
        id: "c1",
        kind: "component",
        source: "host",
        name: "Card",
        props: { title: "SharedReact", body: "bundle1" },
      },
    };
  }

  // ── Generated-UI (GenUI v1) cases ───────────────────────────────────────────
  // These resolve a flat GeneratedPayload HOST-SIDE via createGenUISession and
  // render the resulting component tree in the same sandbox. The live session +
  // a JSON-Pointer patch helper are exposed for the ui-delta gate.

  const VERSION = "flowlet-genui/v1";

  async function gen(
    payload: GeneratedPayload,
    opts?: { ext?: boolean },
  ): Promise<StageInitPayload> {
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
      // ext: externalized bundle (React from the import-map shim) — required for
      // cases whose generated code does `import React from "react"`.
      bundleSource: opts?.ext ? await bundleExt() : await bundle(),
      tree: session.tree,
      generatedComponents: payload.components,
    };
  }

  if (kind === "gen-basic") {
    // A generated tree of prewired primitives (Stack/Text) plus a host
    // component resolved by name (Card) — proves both render in one stage.
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["t1", "c1"] },
        { id: "t1", component: "Text", source: "prewired", props: { text: "hello" } },
        {
          id: "c1",
          component: "Card",
          source: "host",
          props: { title: "Card title", body: "from genui" },
        },
      ],
    });
  }

  if (kind === "mixed") {
    // prewired (__row/__badge) + host (Card) + a REAL generated component
    // (Badge2) coexist in one stage under the current generated-node model.
    // Uses the externalized bundle so the generated code's `import React` and
    // the host components share one React via the import map.
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "__row", source: "prewired", children: ["b1", "c1", "g1"] },
        { id: "b1", component: "__badge", source: "prewired", props: { label: "New" } },
        { id: "c1", component: "Card", source: "host", props: { title: "Hello", body: "World" } },
        { id: "g1", component: "Badge2", source: "generated" },
      ],
      components: {
        Badge2:
          "import React from 'react'; export default function Badge2(){ return React.createElement('div', { 'data-generated-impl': 'Badge2' }, 'gen'); }",
      },
    }, { ext: true });
  }

  if (kind === "gen-unknown") {
    // A generated tree that references an UNKNOWN host component name. The
    // runtime renders a contained [data-error] node for the unknown name while
    // the present sibling Text still renders — per-node isolation.
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["t1", "nope"] },
        { id: "t1", component: "Text", source: "prewired", props: { text: "sibling lives" } },
        { id: "nope", component: "NopeNotReal", source: "host" },
      ],
    });
  }

  if (kind === "gen-delta") {
    // A Card whose title binds to /acct/name — used to drive a prop-level data
    // delta and prove the host element is reconciled in place (no remount).
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["c1"] },
        {
          id: "c1",
          component: "Card",
          source: "host",
          props: { title: { $path: "/acct/name" }, body: "balance" },
        },
      ],
      data: { acct: { name: "Before" } },
    });
  }

  if (kind === "gen-skeleton") {
    // "missing" is referenced as a child but absent from nodes (forward
    // reference) → the resolver emits a Skeleton with that id. A present
    // sibling Text renders normally. __supplyMissing swaps the skeleton for
    // real content via a structural node replace, proving a live swap works.
    (window as any).__supplyMissing = () =>
      controller.update({
        replace: {
          nodeId: "missing",
          node: {
            id: "missing",
            kind: "component",
            source: "prewired",
            name: "Text",
            props: { text: "now here" },
          },
        },
      });
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["present", "missing"] },
        { id: "present", component: "Text", source: "prewired", props: { text: "present text" } },
      ],
    });
  }

  if (kind === "e2e") {
    // A live-LLM-generated payload injected by the e2e spec via addInitScript
    // BEFORE navigation. We resolve it host-side; on success the stage renders
    // the real component tree (Card resolves from the host bundle), on failure
    // we surface the validation message on #e2e-error for the spec to assert.
    const payload = (window as any).__e2ePayload as GeneratedPayload;
    const result = createGenUISession(payload);
    if (!result.ok) {
      ensure("e2e-error").textContent = `${result.error.code}: ${result.error.message}`;
      return {
        theme: {},
        state: {},
        bundleSource: "",
        tree: { id: "root", kind: "generated", payload: null },
      };
    }
    (window as any).__session = result.session;
    return { theme, state: {}, bundleSource: await bundle(), tree: result.session.tree };
  }

  if (kind === "gen-code") {
    // A NOVEL generated component meshed with a prewired Text and a host Card
    // in one tree — the Tier 2.5 capability gate. It also receives a $path-bound
    // prop and dispatches through its per-node flowlet closure.
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

  if (kind === "gen-jsx") {
    // A generated component whose source is the AUTOMATIC JSX RUNTIME output
    // (imports { jsx } from "react/jsx-runtime") — proves the automatic-runtime
    // shape resolves against the React shim in the real box, unlike gen-code's
    // React.createElement path. Source is hand-written as already-compiled
    // automatic-runtime output (the stage feeds component source straight in).
    return gen({
      formatVersion: VERSION,
      root: "root",
      nodes: [{ id: "root", component: "JsxComp", source: "generated" }],
      components: {
        JsxComp:
          'import { jsx as _jsx } from "react/jsx-runtime"; export default function JsxComp(){ return _jsx("div", { "data-generated-impl": "JsxComp", children: "jsx works" }); }',
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

  // Default: empty stage (used by load + bridge gate)
  return {
    theme: {},
    state: {},
    bundleSource: "",
    tree: { id: "root", kind: "generated", payload: null },
  };
}

// ── Message handler (non-RPC messages from the runtime) ───────────────────────

window.addEventListener("message", async (e) => {
  const d = e.data as Record<string, unknown> | undefined;
  if (!d?.flowlet) return;

  if (d["type"] === "ready") {
    statusEl.textContent = "ready";
    const payload = await payloadFor(params.get("case") ?? "");
    try {
      await controller.initialize(payload);
    } catch (err) {
      console.error("[host] initialize failed", err);
    }
  }

  if (d["type"] === "init-ack") {
    ensure("init-ack").textContent = "initialized";
  }

  if (d["type"] === "egress") {
    ensure("egress-fetch").textContent = String(d["fetchResult"]);
    ensure("egress-img").textContent = String(d["imgResult"]);
  }
});
