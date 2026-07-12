import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Json, ToolOutcome } from "@vendoai/core";
import { ContainedNotice } from "../notice.js";
import { JAIL_RUNTIME_SOURCE } from "./runtime-bundle.gen.js";

const MAX_JAIL_HEIGHT = 8_192;

function buildJailSrcdoc(): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  // 'unsafe-eval' (not blob:/hosts): generated code evaluates via the
  // runtime's controlled `require` (sucrase rewrites every import form),
  // so no script-src source may permit a module-loader fetch — a blob-ESM
  // dynamic import("https://…") was browser-verified to initiate a request
  // despite script-src, which is why blob: is banned here.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
  ].join("; ");
  const safeRuntime = JAIL_RUNTIME_SOURCE.replace(/<\/script/gi, "<\\/script");
  return [
    "<!doctype html><html lang=\"en\"><head>",
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<style>html,body{margin:0;padding:0;background:transparent}</style>",
    "<title>Generated Vendo component</title></head><body>",
    `<script nonce="${nonce}">${safeRuntime}<\/script>`,
    "</body></html>",
  ].join("");
}

export interface JailedComponentProps {
  name: string;
  source: string;
  props: Record<string, unknown>;
  onAction(action: string, payload?: Json): Promise<ToolOutcome>;
  onStateSet(key: string, value: Json): void;
}

/** 08-ui §5 — generated code runs only in this opaque-origin iframe. */
export function JailedComponent({
  name,
  source,
  props,
  onAction,
  onStateSet,
}: JailedComponentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  const srcDoc = useMemo(buildJailSrcdoc, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const sendRender = () => {
      iframe.contentWindow?.postMessage({ vendo: true, kind: "render", source, props }, "*");
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
  }, [onAction, onStateSet, props, source]);

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
