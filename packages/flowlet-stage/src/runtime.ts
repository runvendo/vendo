/**
 * STAGE_RUNTIME_SRC — plain JS that executes inside the sandboxed iframe.
 *
 * Ported from spike/stage-runtime.ts and hardened with:
 *   1. Persistent root (created once, stored as window.__flowletRoot)
 *   2. ui/update handler (theme / state / node patch + re-render)
 *   3. Approval-pending dispatch (two-phase: pending → ui/action-result resolves)
 */
export const STAGE_RUNTIME_SRC = String.raw`
  // ── DOM scaffold ────────────────────────────────────────────────────────────
  var root = document.createElement("div");
  root.id = "stage-root";
  root.style.minHeight = "1px";
  document.body.appendChild(root);

  // ── Module-level state ───────────────────────────────────────────────────────
  var currentParams = null;   // { theme, state, tree, bundleSource }
  var __pendingActions = {};  // actionId → resolve fn (approval-pending dispatch)
  var currentCapabilityMap = {}; // nodeId → capability token (built from tree on ui/initialize)

  // ── Theme injection ──────────────────────────────────────────────────────────
  function injectTheme(theme) {
    var style = document.createElement("style");
    style.id = "__flowlet-theme";
    var existing = document.getElementById("__flowlet-theme");
    if (existing) existing.remove();
    style.textContent = ":root{" + Object.keys(theme || {}).map(function(k) {
      return k + ":" + theme[k];
    }).join(";") + "}";
    document.head.appendChild(style);
  }

  // ── Bundle loader ────────────────────────────────────────────────────────────
  async function loadBundle(src) {
    if (!src) return {};
    var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await import(/* @vite-ignore */ url); // sets window.__React/__createRoot/__FLOWLET_HOST__
    return window.__FLOWLET_HOST__ || {};
  }

  // ── Prop binding ($state substitution) ──────────────────────────────────────
  function bindProps(props, state) {
    var out = {};
    var keys = Object.keys(props || {});
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = props[k];
      out[k] = (v && typeof v === "object" && "$state" in v) ? (state || {})[v.$state] : v;
    }
    return out;
  }

  // ── Error boundary factory ───────────────────────────────────────────────────
  function makeEB(R) {
    return class EB extends R.Component {
      constructor(p) { super(p); this.state = { err: false }; }
      static getDerivedStateFromError() { return { err: true }; }
      render() {
        return this.state.err
          ? R.createElement("div", { "data-error-boundary": true }, "render error")
          : this.props.children;
      }
    };
  }

  // ── Tree helpers ─────────────────────────────────────────────────────────────
  // Build a flat nodeId → capability map by walking the tree recursively.
  function buildCapabilityMap(node, map) {
    if (!node) return;
    if (node.id && node.capability) map[node.id] = node.capability;
    (node.children || []).forEach(function(c) { buildCapabilityMap(c, map); });
  }

  // Recursive find-and-replace: swap the node whose id === targetId with newNode.
  function replaceNode(node, targetId, newNode) {
    if (!node) return node;
    if (node.id === targetId) return newNode;
    if (!node.children || !node.children.length) return node;
    return Object.assign({}, node, {
      children: node.children.map(function(c) { return replaceNode(c, targetId, newNode); })
    });
  }

  // ── Renderer ─────────────────────────────────────────────────────────────────
  // host is cached after first bundle load so re-renders don't re-fetch.
  var cachedHost = null;

  function buildElement(host, params, EB) {
    var React = window.__React;
    function toElement(node) {
      if (node.kind === "component") {
        var Impl = host[node.name];
        if (!Impl) return React.createElement("div", { "data-error": "unknown:" + node.name });
        var boundProps = bindProps(node.props, params.state);
        boundProps.__nodeId = node.id;
        var kids = (node.children || []).map(function(c) { return wrap(c); });
        return kids.length
          ? React.createElement(Impl, boundProps, kids)
          : React.createElement(Impl, boundProps);
      }
      return React.createElement("div", { "data-generated": true }, "[generated]");
    }
    function wrap(node) {
      return React.createElement(EB, { key: node.id }, toElement(node));
    }
    return wrap(params.tree);
  }

  // Re-render the current tree into the persistent root.
  function rerender() {
    if (!currentParams || !window.__flowletRoot) return;
    var EB = makeEB(window.__React);
    window.__flowletRoot.render(buildElement(cachedHost || {}, currentParams, EB));
  }

  // Full render: load bundle, create or reuse root, inject theme.
  async function render(params) {
    currentParams = params;
    injectTheme(params.theme || {});
    cachedHost = await loadBundle(params.bundleSource);

    var React = window.__React, createRoot = window.__createRoot;
    var EB = makeEB(React);

    // Create the root once and persist it.
    if (!window.__flowletRoot) {
      window.__flowletRoot = createRoot(document.getElementById("stage-root"));
    }
    window.__flowletRoot.render(buildElement(cachedHost, currentParams, EB));
  }

  // ── Approval-pending dispatch ─────────────────────────────────────────────────
  window.__flowletDispatch = function(descriptor, originNodeId) {
    var id = "act-" + crypto.randomUUID();
    return new Promise(function(resolve) {
      // One-time listener for the direct reply from the host.
      function handler(e) {
        if (e.source !== parent) return;
        if (e.data && e.data.flowlet && e.data.id === id) {
          window.removeEventListener("message", handler);
          var result = e.data.result;
          if (result && result.status === "pending") {
            // Two-phase: wait for ui/action-result with this actionId.
            __pendingActions[result.actionId] = resolve;
          } else {
            // Non-pending: resolve immediately.
            resolve(result);
          }
        }
      }
      window.addEventListener("message", handler);
      parent.postMessage({
        flowlet: true,
        id: id,
        method: "tools/call",
        params: {
          name: descriptor.action,
          originNodeId: originNodeId,
          capability: currentCapabilityMap[originNodeId],
          payload: descriptor.payload
        }
      }, "*");
    });
  };

  // ── Message listener ──────────────────────────────────────────────────────────
  window.addEventListener("message", function(e) {
    var m = e.data;
    if (!m || !m.flowlet) return;
    if (e.source !== parent) return;

    // ── ui/initialize ──────────────────────────────────────────────────────────
    if (m.method === "ui/initialize") {
      currentCapabilityMap = {};
      buildCapabilityMap((m.params || {}).tree, currentCapabilityMap);
      parent.postMessage({ flowlet: true, id: m.id, result: { ok: true } }, "*");
      parent.postMessage({ flowlet: true, type: "init-ack" }, "*");
      render(m.params).catch(function(err) { console.error("[flowlet] render error", err); });
      return;
    }

    // ── ui/update ─────────────────────────────────────────────────────────────
    if (m.method === "ui/update") {
      if (!currentParams) {
        parent.postMessage({ flowlet: true, id: m.id, result: { ok: false, error: "not initialized" } }, "*");
        return;
      }
      var p = m.params || {};

      // Apply theme patch.
      if (p.theme) {
        currentParams = Object.assign({}, currentParams, { theme: p.theme });
        injectTheme(currentParams.theme);
      }

      // Apply state patch.
      if (p.state) {
        currentParams = Object.assign({}, currentParams, { state: p.state });
      }

      // Apply node patch (find-and-replace by id, including root).
      if (p.node && p.nodeId) {
        buildCapabilityMap(p.node, currentCapabilityMap);
        currentParams = Object.assign({}, currentParams, {
          tree: replaceNode(currentParams.tree, p.nodeId, p.node)
        });
      }

      rerender();
      parent.postMessage({ flowlet: true, id: m.id, result: { ok: true } }, "*");
      return;
    }

    // ── ui/action-result (approval-pending resolution) ─────────────────────────
    if (m.method === "ui/action-result") {
      var ap = m.params || {};
      var resolve = __pendingActions[ap.actionId];
      if (resolve) {
        delete __pendingActions[ap.actionId];
        resolve(ap.result);
      }
      return;
    }
  });

  // ── Auto-size via ResizeObserver ───────────────────────────────────────────────
  var lastH = 0;
  var ro = new ResizeObserver(function() {
    var h = document.documentElement.scrollHeight;
    if (Math.abs(h - lastH) > 1) {
      lastH = h;
      parent.postMessage({ flowlet: true, type: "resize", height: h }, "*");
    }
  });
  ro.observe(document.documentElement);

  parent.postMessage({ flowlet: true, type: "ready" }, "*");
`;
