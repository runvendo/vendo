import type { ActionRequest, ActionResult, UINode } from "@flowlet/core";
import type { MessageEndpoint } from "./protocol";
import { makeRpc } from "./bridge";
import { STAGE_RUNTIME_SRC } from "./runtime";

// ── CSP ──────────────────────────────────────────────────────────────────────

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
].join("; ");

// ── buildSrcdoc ───────────────────────────────────────────────────────────────

/**
 * Pure: returns the srcdoc HTML for the sandboxed iframe.
 *
 * When `reactRuntimeSrc` is provided the srcdoc includes a synchronous
 * (non-module) bootstrap script that runs *before* the deferred module
 * runtime.  It:
 *   1. Creates a blob: URL from the React shim source.
 *   2. Records it as `window.__FLOWLET_REACT_URL` for the runtime.
 *   3. Injects `<script type="importmap">` mapping "react", "react-dom",
 *      "react-dom/client", and "react/jsx-runtime" to that blob URL.
 *
 * Because non-module scripts execute synchronously during parsing and module
 * scripts are deferred until after parsing, the import map is guaranteed to be
 * in place before the module runtime executes its first `import()`.
 *
 * Without `reactRuntimeSrc` the original self-contained bundle path is used
 * unchanged (the bundle ships its own React and sets window.__React).
 */
export function buildSrcdoc(reactRuntimeSrc?: string): string {
  let reactSetupScript = "";
  if (reactRuntimeSrc) {
    // Embed the shim source as a JSON string literal safe for inline HTML.
    // Escape < so "</script>" cannot appear inside the <script> body.
    const safeJson = JSON.stringify(reactRuntimeSrc).replace(/</g, "\\u003c");
    reactSetupScript =
      `<script>` +
      `(function(){` +
      `var _s=${safeJson};` +
      `var _u=URL.createObjectURL(new Blob([_s],{type:"text/javascript"}));` +
      `window.__FLOWLET_REACT_URL=_u;` +
      `var _im=document.createElement('script');` +
      `_im.type='importmap';` +
      `_im.textContent=JSON.stringify({imports:{` +
      `"react":_u,` +
      `"react-dom":_u,` +
      `"react-dom/client":_u,` +
      `"react/jsx-runtime":_u` +
      `}});` +
      `document.head.appendChild(_im);` +
      `})();` +
      `<\/script>`;
  }
  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<title>Flowlet Stage</title>` +
    `</head><body>${reactSetupScript}` +
    `<script type="module">${STAGE_RUNTIME_SRC}<\/script>` +
    `</body></html>`
  );
}

// ── Endpoint pair ─────────────────────────────────────────────────────────────

export interface StageEndpoints {
  /** Endpoint the host listens on for messages from the runtime. */
  listen: MessageEndpoint;
  /** Endpoint the host posts to; the runtime receives messages here. */
  post: MessageEndpoint;
}

// ── createStage (DOM-only, tested via browser suite) ─────────────────────────

/**
 * Creates and mounts a sandboxed iframe.
 * Returns the iframe and the endpoint pair needed by `connectStage`.
 *
 * `opts.reactSource` — if provided, the React shim source is embedded in the
 * srcdoc and an import map is set up so externalized host bundles share one
 * React instance. When omitted the self-contained bundle path is used.
 */
export function createStage(
  slot: HTMLElement,
  opts?: { reactSource?: string },
): {
  iframe: HTMLIFrameElement;
  endpoints: StageEndpoints;
} {
  const iframe = document.createElement("iframe");
  iframe.id = "flowlet-stage";
  iframe.title = "Flowlet stage";
  iframe.setAttribute("sandbox", "allow-scripts"); // no allow-same-origin → opaque origin
  iframe.srcdoc = buildSrcdoc(opts?.reactSource);
  iframe.style.cssText = "width:100%;min-height:1px;border:0;";
  slot.appendChild(iframe);
  // Wrap contentWindow.postMessage to supply the required targetOrigin ("*").
  // The MessageEndpoint interface only takes one argument, but the browser's
  // Window.postMessage requires targetOrigin — without it Chrome throws.
  const postEndpoint: MessageEndpoint = {
    postMessage: (msg) => iframe.contentWindow!.postMessage(msg, "*"),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return {
    iframe,
    endpoints: {
      listen: window as unknown as MessageEndpoint,
      post: postEndpoint,
    },
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Payload for `controller.initialize()`. */
export interface StageInitPayload {
  theme: Record<string, string>;
  state: Record<string, unknown>;
  bundleSource: string;
  tree: UINode;
}

/** Payload for `controller.update()`. */
export interface StageUpdatePayload {
  theme?: Record<string, string>;
  state?: Record<string, unknown>;
  node?: UINode;
  nodeId?: string;
}

/** Callback the host app provides to handle every validated action. */
export type OnAction = (req: ActionRequest) => Promise<ActionResult | { pending: true }>;

/** Controller returned by `connectStage`. */
export interface StageController {
  /** Resolves when the runtime posts its `{ flowlet:true, type:"ready" }` notification. */
  ready: Promise<void>;
  initialize(payload: StageInitPayload): Promise<unknown>;
  update(update: StageUpdatePayload): Promise<unknown>;
  resolveAction(actionId: string, result: ActionResult): void;
  dispose(): void;
}

// ── Capability helpers ────────────────────────────────────────────────────────

type NodeLike = { id: string; children?: NodeLike[] } & Record<string, unknown>;

let _tokenSeq = 0;
function mintToken(): string {
  return `tok-${++_tokenSeq}-${Math.random().toString(36).slice(2)}`;
}

let _actionSeq = 0;
function mintActionId(): string {
  return `action-${++_actionSeq}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Walks the tree recursively, minting a unique capability token per node id
 * and attaching it as `capability` on each node. Returns the augmented tree.
 */
function attachCapabilities(node: NodeLike, map: Map<string, string>): NodeLike {
  const token = mintToken();
  map.set(node.id, token);
  const children = Array.isArray(node.children)
    ? node.children.map((c) => attachCapabilities(c, map))
    : undefined;
  return { ...node, capability: token, ...(children !== undefined ? { children } : {}) };
}

// ── connectStage ──────────────────────────────────────────────────────────────

/**
 * The testable core: wires the RPC bridge and exposes the `StageController`.
 * Does not touch the real DOM or `window` — only uses `MessageEndpoint`s.
 */
export function connectStage(
  endpoints: StageEndpoints,
  { onAction }: { onAction: OnAction },
): StageController {
  const capabilityMap = new Map<string, string>();

  // ready: resolves when the runtime posts { flowlet:true, type:"ready" }.
  // This is NOT an RPC call — it's a one-way notification, so we handle it
  // with a dedicated listener on the host-listen endpoint.
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => { resolveReady = res; });
  const readyHandler = (e: { data: unknown }) => {
    const d = e.data as Record<string, unknown>;
    if (d?.flowlet === true && d?.type === "ready") {
      resolveReady();
    }
  };
  endpoints.listen.addEventListener("message", readyHandler);

  const rpc = makeRpc(endpoints.listen, endpoints.post, async (method, params) => {
    if (method === "tools/call") {
      const p = params as {
        name: string;
        originNodeId: string;
        capability: unknown;
        payload?: unknown;
      };

      // Capability chokepoint: unknown node or wrong token → bridge error
      const expectedToken = capabilityMap.get(p.originNodeId);
      if (!expectedToken || expectedToken !== p.capability) {
        throw new Error(`capability mismatch for node "${p.originNodeId}"`);
      }

      // Map to F1 ActionRequest
      const req: ActionRequest = {
        requestId: mintToken(),
        originNodeId: p.originNodeId,
        action: p.name,
        payload: p.payload,
        capability: p.capability,
      };

      const outcome = await onAction(req);

      // Approval-pending: defer resolution; runtime waits for ui/action-result
      if ("pending" in outcome && outcome.pending === true) {
        const actionId = mintActionId();
        return { status: "pending", actionId };
      }

      return outcome;
    }

    throw new Error(`unknown method: ${method}`);
  });

  return {
    ready,

    initialize(payload) {
      const augmentedTree = attachCapabilities(payload.tree as unknown as NodeLike, capabilityMap);
      return rpc.call("ui/initialize", { ...payload, tree: augmentedTree });
    },

    update(update) {
      return rpc.call("ui/update", update);
    },

    resolveAction(actionId, result) {
      // Post the notification directly (not via RPC — no response expected).
      // The runtime's message listener catches method === "ui/action-result".
      endpoints.post.postMessage({
        flowlet: true,
        method: "ui/action-result",
        params: { actionId, result },
      });
    },

    dispose() {
      endpoints.listen.removeEventListener("message", readyHandler);
      rpc.dispose();
    },
  };
}
