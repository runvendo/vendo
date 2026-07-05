/**
 * STAGE_RUNTIME_SRC — plain JS that executes inside the sandboxed iframe.
 *
 * Ported from spike/stage-runtime.ts and hardened with:
 *   1. Persistent root (created once, stored as window.__vendoRoot)
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
  var currentParams = null;   // { theme, state, tree, bundleSource, generatedComponents, componentTheme }
  var __pendingActions = {};  // actionId → { resolve, reject } (approval-pending dispatch)
  var currentCapabilityMap = {}; // nodeId → capability token (built from tree on ui/initialize)
  var cachedEB = null; // ErrorBoundary class, built once (see getEB) and reused across renders

  // ── Theme injection ──────────────────────────────────────────────────────────
  function injectTheme(theme) {
    var style = document.createElement("style");
    style.id = "__vendo-theme";
    var existing = document.getElementById("__vendo-theme");
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
    try {
      await import(/* @vite-ignore */ url); // sets window.__React/__createRoot/__VENDO_HOST__
    } finally {
      // The module is cached by the loader once evaluated; the blob URL is only
      // needed during fetch, so release it to avoid leaking object URLs.
      URL.revokeObjectURL(url);
    }
    return window.__VENDO_HOST__ || {};
  }

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
      componentDidUpdate(prevProps) {
        // A node keyed to this boundary that threw once stays in the error state
        // forever otherwise. When the child element changes (e.g. a ui/update or
        // ui-delta supplies new, valid props) clear the error so the next render
        // retries the new child.
        if (prevProps.children !== this.props.children && this.state.err) {
          this.setState({ err: false });
        }
      }
      render() {
        return this.state.err
          ? R.createElement("div", { "data-error-boundary": true }, "render error")
          : this.props.children;
      }
    };
  }

  // Build the ErrorBoundary class once and reuse it across renders. A fresh class
  // per render is a NEW React component type, so React would remount the whole
  // tree on every ui/update (destroying DOM identity); caching keeps element
  // identity stable so prop-level updates reconcile in place. Mirrors cachedHost.
  function getEB() {
    return cachedEB || (cachedEB = makeEB(window.__React));
  }

  // ── Tree helpers ─────────────────────────────────────────────────────────────
  // Build a flat nodeId → capability map by walking the tree recursively.
  function buildCapabilityMap(node, map) {
    if (!node) return;
    if (node.id && node.capability) map[node.id] = node.capability;
    (node.children || []).forEach(function(c) { buildCapabilityMap(c, map); });
  }

  // Recursive find-and-replace: swap the node whose id === targetId with newNode.
  // ctx.found is flipped to true when a replacement actually happens, so callers
  // can distinguish a real replace from a no-op (unknown nodeId).
  function replaceNode(node, targetId, newNode, ctx) {
    if (!node) return node;
    if (node.id === targetId) { if (ctx) ctx.found = true; return newNode; }
    if (!node.children || !node.children.length) return node;
    return Object.assign({}, node, {
      children: node.children.map(function(c) { return replaceNode(c, targetId, newNode, ctx); })
    });
  }

  // ── Built-in prewired primitives ──────────────────────────────────────────────
  // Layout/text/skeleton components referenced by name when node.source === "prewired".
  // Each reads window.__React at call time (React isn't available at module-eval time).
  // Keep the keys in sync with RESERVED_COMPONENT_NAMES in @vendoai/core's
  // genui/format.ts — the format reserves exactly these names so generated
  // components can't shadow them (pinned by a drift-guard test in runtime.test.ts).
  // Every visual value is either a --vendo-* token or a neutral scale value,
  // so the primitives stay host-agnostic: the brand arrives via the theme vars.

  // Named spacing scale for gap/padding: tokens the model can reason about.
  // Numbers are px; unknown strings pass through (raw CSS lengths keep working).
  var SPACE = { xs: "4px", sm: "8px", md: "12px", lg: "20px", xl: "32px" };
  function space(v, dflt) {
    if (v == null) return dflt;
    if (typeof v === "number") return v + "px";
    return SPACE[v] || v;
  }
  // Text variants: host-like hierarchy from tokens (label = the uppercase
  // letter-spaced section label most product UIs use; value = tabular numerals).
  var TEXT_VARIANTS = {
    title:   { fontSize: "16px", fontWeight: 600, letterSpacing: "-0.01em" },
    heading: { fontSize: "20px", fontWeight: 650, letterSpacing: "-0.015em" },
    label:   { fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--vendo-fg-muted, rgba(0,0,0,0.55))" },
    muted:   { color: "var(--vendo-fg-muted, rgba(0,0,0,0.55))" },
    caption: { fontSize: "12px", color: "var(--vendo-fg-muted, rgba(0,0,0,0.55))" },
    value:   { fontSize: "22px", fontWeight: 650, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" }
  };

  var PRIMITIVES = {
    Stack: function(props) {
      var R = window.__React;
      return R.createElement("div", {
        "data-primitive": "Stack",
        style: {
          display: "flex", flexDirection: "column",
          gap: space(props.gap, "8px"),
          padding: space(props.padding, undefined),
          alignItems: props.align || undefined,
          justifyContent: props.justify || undefined
        }
      }, props.children);
    },
    Row: function(props) {
      var R = window.__React;
      return R.createElement("div", {
        "data-primitive": "Row",
        style: {
          display: "flex", flexDirection: "row",
          gap: space(props.gap, "8px"),
          padding: space(props.padding, undefined),
          alignItems: props.align || "stretch",
          justifyContent: props.justify || undefined,
          flexWrap: props.wrap ? "wrap" : undefined
        }
      }, props.children);
    },
    Grid: function(props) {
      var R = window.__React;
      return R.createElement("div", {
        "data-primitive": "Grid",
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(" + (props.columns || 2) + ", 1fr)",
          gap: space(props.gap, "8px"),
          padding: space(props.padding, undefined)
        }
      }, props.children);
    },
    Surface: function(props) {
      // The host-card container: surface bg, hairline border, brand radius and
      // shadow, roomy padding — the building block for host-native panels.
      var R = window.__React;
      return R.createElement("div", {
        "data-primitive": "Surface",
        style: {
          background: "var(--vendo-surface, #fff)",
          border: "1px solid var(--vendo-border, rgba(0,0,0,0.10))",
          borderRadius: "var(--vendo-radius, 12px)",
          boxShadow: "var(--vendo-shadow, none)",
          padding: space(props.padding, SPACE.lg),
          display: "flex", flexDirection: "column",
          gap: space(props.gap, "8px")
        }
      }, props.children);
    },
    Divider: function(props) {
      var R = window.__React;
      var vertical = props.vertical === true;
      return R.createElement("div", {
        "data-primitive": "Divider",
        "aria-hidden": "true",
        style: vertical
          ? { width: "1px", alignSelf: "stretch", background: "var(--vendo-border, rgba(0,0,0,0.10))" }
          : { height: "1px", width: "100%", background: "var(--vendo-border, rgba(0,0,0,0.10))" }
      });
    },
    Text: function(props) {
      var R = window.__React;
      // props.as is LLM-controlled; allowlist to safe text tags so it can't be
      // used to inject arbitrary (e.g. interactive/structural) elements. Anything
      // off the list falls back to "span".
      var TEXT_TAGS = { span:1, p:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, strong:1, em:1, small:1, label:1, div:1 };
      var tag = (props.as && TEXT_TAGS[props.as]) ? props.as : "span";
      var style = { color: "var(--vendo-fg, inherit)" };
      var variant = TEXT_VARIANTS[props.variant];
      if (variant) for (var k in variant) style[k] = variant[k];
      if (props.align) style.textAlign = props.align;
      return R.createElement(tag, {
        "data-primitive": "Text",
        "data-variant": variant ? props.variant : undefined,
        style: style
      }, props.text != null ? props.text : props.children);
    },
    Skeleton: function(props) {
      var R = window.__React;
      return R.createElement("div", {
        "data-primitive": "Skeleton",
        "data-skeleton": "true",
        "aria-hidden": "true",
        style: {
          background: "var(--vendo-skeleton, rgba(0,0,0,0.08))",
          minHeight: props.height || "16px",
          width: props.width || "100%",
          borderRadius: "4px"
        }
      });
    }
  };

  // ── Renderer ─────────────────────────────────────────────────────────────────
  // host is cached after first bundle load so re-renders don't re-fetch.
  var cachedHost = null;
  var cachedGenerated = {};   // name → component fn (loaded generated modules)
  var generatedErrors = {};   // name → error message (load/shape failures)

  function buildElement(host, params, EB) {
    var React = window.__React;
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
        if (!Impl) {
          // Clear error story: an unregistered name renders a visible, contained
          // notice (not an invisible empty div) so a bad registration or a
          // hallucinated component name is diagnosable at a glance.
          return React.createElement("div", {
            "data-error": "unknown:" + node.name,
            style: {
              padding: "8px 12px", fontSize: "12px",
              color: "var(--vendo-fg-muted, rgba(0,0,0,0.55))",
              border: "1px dashed var(--vendo-border, rgba(0,0,0,0.2))",
              borderRadius: "var(--vendo-radius, 8px)"
            }
          }, 'Unknown component "' + node.name + '"');
        }
        var boundProps = bindProps(node.props, params.state);
        boundProps.__nodeId = node.id;
        // Per-node dispatch closure for EVERY source (generated, catalog, host):
        // origin is fixed by the runtime, so component code cannot pick an
        // originNodeId. (originNodeId is bookkeeping, not a trust boundary — the
        // host policy decides on the ACTION.) Catalog action affordances
        // (Actions) and host components use the same governed door.
        boundProps.vendo = {
          dispatch: function(descriptor) { return window.__vendoDispatch(descriptor, node.id); }
        };
        var kids = (node.children || []).map(function(c) { return wrap(c); });
        return kids.length
          ? React.createElement(Impl, boundProps, kids)
          : React.createElement(Impl, boundProps);
      }
      return React.createElement("div", { "data-error": "unresolved-generated:" + node.id });
    }
    function wrap(node) {
      return React.createElement(EB, { key: node.id }, toElement(node));
    }
    var el = wrap(params.tree);
    // Mount the OpenUI ThemeProvider (or any bundle-supplied wrapper) around the
    // rendered tree when the init payload carried an opaque componentTheme AND the
    // host bundle exposed a wrapper. The runtime stays generic — it never inspects
    // the theme's shape, only forwards it to the bundle's wrapper.
    if (params.componentTheme && window.__VENDO_THEME_WRAP__) {
      el = window.__VENDO_THEME_WRAP__(params.componentTheme, el);
    }
    return el;
  }

  // Re-render the current tree into the persistent root.
  function rerender() {
    if (!currentParams || !window.__vendoRoot) return;
    var EB = getEB();
    window.__vendoRoot.render(buildElement(cachedHost || {}, currentParams, EB));
  }

  // Full render: load bundle, create or reuse root, inject theme.
  async function render(params) {
    currentParams = params;
    // Anchor data feed for the swr shim (set BEFORE any generated module
    // evaluates or renders — useSWR reads it synchronously).
    window.__vendoAnchorData = params.anchorData || {};
    injectTheme(params.theme || {});
    cachedHost = await loadBundle(params.bundleSource);
    var gen = await loadGeneratedComponents(params.generatedComponents);
    cachedGenerated = gen.components;
    generatedErrors = gen.errors;

    var React = window.__React, createRoot = window.__createRoot;
    var EB = getEB();

    // Create the root once and persist it.
    if (!window.__vendoRoot) {
      window.__vendoRoot = createRoot(document.getElementById("stage-root"));
    }
    window.__vendoRoot.render(buildElement(cachedHost, currentParams, EB));
  }

  // ── Approval-pending dispatch ─────────────────────────────────────────────────
  window.__vendoDispatch = function(descriptor, originNodeId) {
    var id = "act-" + crypto.randomUUID();
    return new Promise(function(resolve, reject) {
      // One-time listener for the direct reply from the host.
      function handler(e) {
        if (e.source !== parent) return;
        if (e.data && e.data.vendo && e.data.id === id) {
          window.removeEventListener("message", handler);
          // Bridge ERROR replies (policy deny, unknown action, capability
          // mismatch) must REJECT — resolving undefined would let component
          // code sail down its success path after a blocked action.
          if (e.data.error) {
            reject(Object.assign(new Error(e.data.error.message || "action failed"), { code: e.data.error.code || "bridge" }));
            return;
          }
          var result = e.data.result;
          if (result && result.status === "pending") {
            // Two-phase: wait for ui/action-result with this actionId.
            __pendingActions[result.actionId] = { resolve: resolve, reject: reject };
          } else {
            // Non-pending: resolve immediately.
            resolve(result);
          }
        }
      }
      window.addEventListener("message", handler);
      parent.postMessage({
        vendo: true,
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
    if (!m || !m.vendo) return;
    if (e.source !== parent) return;

    // ── ui/initialize ──────────────────────────────────────────────────────────
    if (m.method === "ui/initialize") {
      currentCapabilityMap = {};
      buildCapabilityMap((m.params || {}).tree, currentCapabilityMap);
      parent.postMessage({ vendo: true, id: m.id, result: { ok: true } }, "*");
      parent.postMessage({ vendo: true, type: "init-ack" }, "*");
      render(m.params).catch(function(err) { console.error("[vendo] render error", err); });
      return;
    }

    // ── ui/update ─────────────────────────────────────────────────────────────
    if (m.method === "ui/update") {
      if (!currentParams) {
        parent.postMessage({ vendo: true, id: m.id, result: { ok: false, error: "not initialized" } }, "*");
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

      // Refresh the swr shim's anchor data (live context re-patch).
      if (p.anchorData) {
        currentParams = Object.assign({}, currentParams, { anchorData: p.anchorData });
        window.__vendoAnchorData = p.anchorData;
      }

      // Apply node patch (find-and-replace by id, including root).
      // node + nodeId travel as one unit (params.replace); a partial patch errors.
      if (p.replace) {
        if (!p.replace.nodeId || !p.replace.node) {
          parent.postMessage({ vendo: true, id: m.id, error: { code: "bridge", message: "ui/update: replace requires both nodeId and node" } }, "*");
          return;
        }
        var ctx = { found: false };
        var newTree = replaceNode(currentParams.tree, p.replace.nodeId, p.replace.node, ctx);
        if (!ctx.found) {
          // Loud error rather than a silent { ok: true } for a no-op replacement.
          parent.postMessage({ vendo: true, id: m.id, error: { code: "bridge", message: "ui/update: unknown nodeId " + p.replace.nodeId } }, "*");
          return;
        }
        currentParams = Object.assign({}, currentParams, { tree: newTree });
        // Rebuild the capability map from scratch so removed descendants lose
        // their tokens (never additive — old subtree ids must not stay valid).
        currentCapabilityMap = {};
        buildCapabilityMap(currentParams.tree, currentCapabilityMap);
      }

      rerender();
      parent.postMessage({ vendo: true, id: m.id, result: { ok: true } }, "*");
      return;
    }

    // ── ui/action-result (approval-pending resolution) ─────────────────────────
    if (m.method === "ui/action-result") {
      var ap = m.params || {};
      var entry = __pendingActions[ap.actionId];
      if (entry) {
        delete __pendingActions[ap.actionId];
        // Settle for both success and error results so the parked promise never leaks.
        if (ap.error) {
          entry.reject(Object.assign(new Error(ap.error.message || "action cancelled"), { code: ap.error.code || "abort" }));
        } else {
          entry.resolve(ap.result);
        }
      }
      return;
    }

    // ── ui/teardown (host is disposing) ────────────────────────────────────────
    if (m.method === "ui/teardown") {
      // Reject every outstanding approval so awaiting components don't hang forever.
      Object.keys(__pendingActions).forEach(function(k) {
        var e2 = __pendingActions[k];
        if (e2 && e2.reject) e2.reject(Object.assign(new Error("stage torn down"), { code: "abort" }));
      });
      __pendingActions = {};
      return;
    }
  });

  // ── Auto-size via ResizeObserver ───────────────────────────────────────────────
  var lastH = 0;
  var ro = new ResizeObserver(function() {
    var h = document.documentElement.scrollHeight;
    if (Math.abs(h - lastH) > 1) {
      lastH = h;
      parent.postMessage({ vendo: true, type: "resize", height: h }, "*");
    }
  });
  ro.observe(document.documentElement);

  parent.postMessage({ vendo: true, type: "ready" }, "*");
`;
