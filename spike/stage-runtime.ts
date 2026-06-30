// Serialized into the srcdoc as an inline module. Minimal for Gate 1: announce ready.
export const STAGE_RUNTIME_SRC = String.raw`
  const root = document.createElement("div");
  root.id = "stage-root";
  root.style.minHeight = "1px";
  document.body.appendChild(root);

  window.addEventListener("message", function (e) {
    var m = e.data; if (!m || !m.flowlet) return;
    if (m.method === "ui/initialize") {
      window.__flowletInit = m.params;
      parent.postMessage({ flowlet: true, id: m.id, result: { ok: true } }, "*");
      parent.postMessage({ flowlet: true, type: "init-ack" }, "*");
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
