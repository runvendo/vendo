import type { ActionRequest, ActionResult, UINode } from "@flowlet/core";
import type { MessageEndpoint } from "./protocol";
import { makeRpc } from "./bridge";
import { STAGE_RUNTIME_SRC } from "./runtime";

// ── CSP ──────────────────────────────────────────────────────────────────────

const CSP_BASE = [
  "default-src 'none'",
  // script-src is built per-call with a nonce (see buildSrcdoc)
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
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // 'strict-dynamic' lets the nonced scripts propagate trust to any scripts
  // they dynamically load (e.g. import() from blob: URLs created at runtime).
  // blob: is kept for older browsers that don't support strict-dynamic fully.
  const csp = `script-src 'nonce-${nonce}' 'strict-dynamic' blob:; ${CSP_BASE}`;

  let reactSetupScript = "";
  if (reactRuntimeSrc) {
    // Embed the shim source as a JSON string literal safe for inline HTML.
    // Escape < so "</script>" cannot appear inside the <script> body.
    const safeJson = JSON.stringify(reactRuntimeSrc).replace(/</g, "\\u003c");
    reactSetupScript =
      `<script nonce="${nonce}">` +
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
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<title>Flowlet Stage</title>` +
    `</head><body>${reactSetupScript}` +
    `<script type="module" nonce="${nonce}">${STAGE_RUNTIME_SRC}<\/script>` +
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

  // Source-filtered listen: only forward messages from this iframe's contentWindow.
  // NOTE: srcdoc iframes are opaque-origin so e.origin === "null" — do NOT use origin;
  // e.source identity is the reliable guard.
  const registeredHandlers = new Map<
    (e: { data: unknown }) => void,
    (e: MessageEvent) => void
  >();
  const listenEndpoint: MessageEndpoint = {
    postMessage: () => {},
    addEventListener(_type, handler) {
      const wrapped = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (!e.data || (e.data as Record<string, unknown>).flowlet !== true) return;
        handler({ data: e.data });
      };
      registeredHandlers.set(handler, wrapped);
      window.addEventListener("message", wrapped);
    },
    removeEventListener(_type, handler) {
      const wrapped = registeredHandlers.get(handler);
      if (wrapped) {
        window.removeEventListener("message", wrapped);
        registeredHandlers.delete(handler);
      }
    },
  };

  return {
    iframe,
    endpoints: {
      listen: listenEndpoint,
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

function mintToken(): string {
  return `cap-${crypto.randomUUID()}`;
}

function mintActionId(): string {
  return `act-${crypto.randomUUID()}`;
}

function mintRequestId(): string {
  return `req-${crypto.randomUUID()}`;
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
  const pendingActionIds = new Set<string>();

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
        requestId: mintRequestId(),
        originNodeId: p.originNodeId,
        action: p.name,
        payload: p.payload,
        capability: p.capability,
      };

      const outcome = await onAction(req);

      // Approval-pending: defer resolution; runtime waits for ui/action-result
      if ("pending" in outcome && outcome.pending === true) {
        const actionId = mintActionId();
        pendingActionIds.add(actionId);
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
      let payload = update;
      if (update.node) {
        const augmentedNode = attachCapabilities(update.node as unknown as NodeLike, capabilityMap);
        payload = { ...update, node: augmentedNode as unknown as UINode };
      }
      return rpc.call("ui/update", payload);
    },

    resolveAction(actionId, result) {
      if (!pendingActionIds.has(actionId)) {
        throw new Error(`resolveAction: unknown actionId "${actionId}"`);
      }
      pendingActionIds.delete(actionId);
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
