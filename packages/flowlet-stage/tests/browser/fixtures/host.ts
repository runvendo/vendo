import { createStage, connectStage } from "@flowlet/stage";
import type { StageInitPayload } from "@flowlet/stage";

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

const reactSource =
  caseParam === "shared-react"
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
    "--brand-primary": "#00aa77",
    "--brand-surface": "#fff",
    "--brand-text": "#111",
  };

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

  if (kind === "mixed") {
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
          {
            id: "b1",
            kind: "component",
            source: "prewired",
            name: "__badge",
            props: { label: "New" },
          },
          {
            id: "c1",
            kind: "component",
            source: "host",
            name: "Card",
            props: { title: "Hello", body: "World" },
          },
          { id: "g1", kind: "generated", payload: { note: "placeholder" } },
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

  if (d["type"] === "resize") {
    iframe.style.height = d["height"] + "px";
  }

  if (d["type"] === "egress") {
    ensure("egress-fetch").textContent = String(d["fetchResult"]);
    ensure("egress-img").textContent = String(d["imgResult"]);
  }
});
