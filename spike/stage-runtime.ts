// Serialized into the srcdoc as an inline module. Minimal for Gate 1: announce ready.
export const STAGE_RUNTIME_SRC = String.raw`
  const root = document.createElement("div");
  root.id = "stage-root";
  root.style.minHeight = "1px";
  document.body.appendChild(root);

  function injectTheme(theme) {
    var style = document.createElement("style");
    style.textContent = ":root{" + Object.keys(theme || {}).map(function(k){return k+":"+theme[k];}).join(";") + "}";
    document.head.appendChild(style);
  }
  async function loadBundle(src) {
    if (!src) return {};
    var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await import(/* @vite-ignore */ url); // executes; sets window.__React/__createRoot/__FLOWLET_HOST__
    return window.__FLOWLET_HOST__ || {};
  }
  async function render(params) {
    injectTheme(params.theme || {});
    var host = await loadBundle(params.bundleSource);
    var React = window.__React, createRoot = window.__createRoot;
    function bindProps(props, state) {
      var out = {};
      var keys = Object.keys(props || {});
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], v = props[k];
        out[k] = (v && typeof v === "object" && "$state" in v) ? (state || {})[v.$state] : v;
      }
      return out;
    }
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
    var EB = makeEB(window.__React);
    function toElement(node) {
      if (node.kind === "component") {
        var Impl = host[node.name];
        if (!Impl) return React.createElement("div", { "data-error": "unknown:" + node.name });
        var boundProps = bindProps(node.props, params.state);
        boundProps.__nodeId = node.id;
        var kids = (node.children || []).map(function(c) { return wrap(c); });
        return kids.length ? React.createElement(Impl, boundProps, kids) : React.createElement(Impl, boundProps);
      }
      return React.createElement("div", { "data-generated": true }, "[generated]");
    }
    function wrap(node) {
      return React.createElement(EB, { key: node.id }, toElement(node));
    }
    createRoot(document.getElementById("stage-root")).render(wrap(params.tree));
  }

  window.__flowletDispatch = function (descriptor, originNodeId) {
    var id = "act-" + Math.random().toString(36).slice(2);
    return new Promise(function (resolve) {
      function handler(e) {
        if (e.data && e.data.flowlet && e.data.id === id) {
          window.removeEventListener("message", handler);
          resolve(e.data.result);
        }
      }
      window.addEventListener("message", handler);
      parent.postMessage({ flowlet: true, id: id, method: "tools/call",
        params: { name: descriptor.action, originNodeId: originNodeId,
                  capability: (window.__flowletInit || {}).capability, payload: descriptor.payload } }, "*");
    });
  };

  window.addEventListener("message", function (e) {
    var m = e.data; if (!m || !m.flowlet) return;
    if (m.method === "ui/initialize") {
      window.__flowletInit = m.params;
      parent.postMessage({ flowlet: true, id: m.id, result: { ok: true } }, "*");
      parent.postMessage({ flowlet: true, type: "init-ack" }, "*");
      render(m.params).catch(function(err){ console.error("[flowlet] render error", err); });
    }
  });

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

  parent.postMessage({ flowlet: true, type: "ready" }, "*");
`;
