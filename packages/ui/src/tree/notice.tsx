import type { CSSProperties } from "react";

const noticeStyle = (danger: boolean): CSSProperties => ({
  display: "block",
  boxSizing: "border-box",
  width: "fit-content",
  maxWidth: "100%",
  color: danger
    ? "var(--vendo-color-danger, #b0392b)"
    : "var(--vendo-color-muted, #6b6b76)",
  background: danger
    ? "color-mix(in srgb, var(--vendo-color-danger, #b0392b) 8%, var(--vendo-color-surface, #f7f7f8))"
    : "color-mix(in srgb, var(--vendo-color-surface, #f7f7f8) 82%, transparent)",
  border: danger
    ? "1px solid color-mix(in srgb, var(--vendo-color-danger, #b0392b) 32%, var(--vendo-color-border, #e3e3e8))"
    : "1px solid var(--vendo-color-border, rgba(20, 21, 26, 0.09))",
  borderRadius: "var(--vendo-radius-medium, 10px)",
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.55)",
  fontFamily: "var(--vendo-font-family, system-ui, sans-serif)",
  fontSize: "var(--vendo-font-size-caption, 12.5px)",
  fontWeight: 500,
  letterSpacing: "-0.006em",
  lineHeight: 1.4,
  padding: "var(--vendo-space-small, 8px) var(--vendo-space-medium, 11px)",
});

/** 01-core §15; 08-ui §5 — a failure may not escape its surface. */
export function ContainedNotice(props: {
  label: string;
  children: string;
  code?: string;
  outcome?: string;
}) {
  const danger = props.outcome === "error" || props.outcome === "blocked";
  return (
    <small
      role="note"
      aria-label={props.label}
      data-error-code={props.code}
      data-vendo-notice={props.outcome ?? "contained"}
      style={noticeStyle(danger)}
    >
      {props.children}
    </small>
  );
}
