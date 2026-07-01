"use client";

/**
 * Runs a self-contained, model-generated app (HTML + inline CSS/JS) inside a
 * sandboxed iframe. This is Flowlet's "generate anything" tier: when a request
 * isn't covered by the prewired components (a game, a calculator, a custom
 * interactive tool), the agent emits a full HTML document and we MOUNT it here
 * as a live, playable app — instead of printing code as text.
 *
 * Security: `sandbox="allow-scripts"` WITHOUT `allow-same-origin` isolates the
 * app — its scripts run, but it cannot reach the host page's DOM, cookies, or
 * storage. It's the same egress-jailed posture as the F3b stage.
 */
import { useState } from "react";

export interface HtmlAppProps {
  html?: string;
  height?: number;
  title?: string;
}

export function HtmlApp({ html = "", height, title }: HtmlAppProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const h = typeof height === "number" && height > 0 ? Math.min(height, 640) : 440;

  return (
    <div
      style={{
        width: "100%",
        borderRadius: 14,
        overflow: "hidden",
        border: "1px solid var(--color-border, #e9e9e5)",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(20,21,26,.04), 0 12px 40px rgba(20,21,26,.1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 12px",
          borderBottom: "1px solid #ececec",
          fontSize: 12.5,
          fontWeight: 600,
          color: "#14151a",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title || "Generated app"}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          title="Restart"
          aria-label="Restart app"
          style={{ border: 0, background: "transparent", color: "#8a8b92", cursor: "pointer", padding: 2, fontSize: 13, lineHeight: 1 }}
        >
          &#8635;
        </button>
      </div>
      <iframe
        key={reloadKey}
        title={title || "Generated app"}
        srcDoc={html}
        sandbox="allow-scripts allow-pointer-lock"
        style={{ width: "100%", height: h, border: 0, display: "block", background: "#fff" }}
      />
    </div>
  );
}
