// Serialized into the srcdoc as an inline module. Minimal for Gate 1: announce ready.
export const STAGE_RUNTIME_SRC = String.raw`
  const root = document.createElement("div");
  root.id = "stage-root";
  root.style.minHeight = "1px";
  document.body.appendChild(root);
  parent.postMessage({ flowlet: true, type: "ready" }, "*");
`;
