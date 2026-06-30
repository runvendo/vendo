import { STAGE_RUNTIME_SRC } from "./stage-runtime";

// CSP that JAILS egress: no network connections, scripts only inline+blob, images only data:.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
].join("; ");

export function createStage(slot: HTMLElement): HTMLIFrameElement {
  const srcdoc = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}">
  </head><body><script type="module">${STAGE_RUNTIME_SRC}<\/script></body></html>`;

  const iframe = document.createElement("iframe");
  iframe.id = "flowlet-stage";
  iframe.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin -> opaque origin
  iframe.srcdoc = srcdoc;
  iframe.style.cssText = "width:100%;min-height:1px;border:0;";
  slot.appendChild(iframe);
  return iframe;
}
