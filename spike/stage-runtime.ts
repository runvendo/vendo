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
    function toElement(node) {
      if (node.kind === "component") {
        var Impl = host[node.name];
        if (!Impl) return React.createElement("div", { "data-error": "unknown:" + node.name });
        return React.createElement(Impl, bindProps(node.props, params.state));
      }
      return React.createElement("div", { "data-generated": true }, "[generated]");
    }
    createRoot(document.getElementById("stage-root")).render(toElement(params.tree));
  }

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
