import type { CSSProperties } from "react";
import type { OpenInProductPayload } from "./shim-core.js";

const cardStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gap: "var(--vendo-space-medium, 16px)",
  alignItems: "start",
  color: "var(--vendo-color-text, #1a1a1e)",
  background: "var(--vendo-color-surface, #ffffff)",
  border: "1px solid var(--vendo-color-border, #e3e3e8)",
  borderRadius: "var(--vendo-radius-medium, 12px)",
  boxShadow: "0 10px 32px color-mix(in srgb, var(--vendo-color-text, #1a1a1e) 9%, transparent)",
  padding: "var(--vendo-space-large, 20px)",
  fontFamily: "var(--vendo-font-family, system-ui, sans-serif)",
};

const markStyle: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 42,
  height: 42,
  borderRadius: "var(--vendo-radius-medium, 12px)",
  color: "var(--vendo-color-accent-text, #ffffff)",
  background: "var(--vendo-color-accent, #111111)",
  fontWeight: 750,
  letterSpacing: "-0.04em",
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  color: "var(--vendo-color-muted, #6b6b76)",
  fontSize: "var(--vendo-font-size-caption, 12.5px)",
  fontWeight: 600,
};

const headingStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--vendo-color-text, #1a1a1e)",
  fontSize: "calc(var(--vendo-font-size, 15px) * 1.2)",
  lineHeight: 1.3,
};

const copyStyle: CSSProperties = {
  margin: "8px 0 0",
  color: "var(--vendo-color-muted, #6b6b76)",
  fontSize: "var(--vendo-font-size, 15px)",
  lineHeight: 1.5,
};

const linkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  marginTop: "var(--vendo-space-medium, 16px)",
  minHeight: 42,
  padding: "0 var(--vendo-space-large, 18px)",
  borderRadius: "var(--vendo-radius-medium, 10px)",
  color: "var(--vendo-color-accent-text, #ffffff)",
  background: "var(--vendo-color-accent, #111111)",
  fontWeight: 650,
  textDecoration: "none",
};

export function HttpOpenCard({ open }: { open: OpenInProductPayload }) {
  const appName = open.appName ?? "Vendo app";
  return (
    <section
      aria-label={`Open ${appName} in ${open.productName}`}
      data-vendo-http-open-card=""
      style={cardStyle}
    >
      <div aria-hidden="true" style={markStyle}>V</div>
      <div>
        <p style={eyebrowStyle}>Open in {open.productName}</p>
        <h2 style={headingStyle}>{appName}</h2>
        <p style={copyStyle}>This app runs securely in the product where it was created.</p>
        <a
          href={open.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${appName}`}
          style={linkStyle}
        >
          Open app&nbsp;↗
        </a>
      </div>
    </section>
  );
}
