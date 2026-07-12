import type { CSSProperties } from "react";

const noticeStyle: CSSProperties = {
  color: "var(--vendo-color-muted, #6b6b76)",
  background: "var(--vendo-color-surface, #f7f7f8)",
  border: "1px solid var(--vendo-color-border, #e3e3e8)",
  borderRadius: "var(--vendo-radius-small, 6px)",
  fontFamily: "var(--vendo-font-family, system-ui, sans-serif)",
  fontSize: "var(--vendo-font-size, 15px)",
  padding: "var(--vendo-space-small, 8px)",
};

/** 01-core §15; 08-ui §5 — a failure may not escape its surface. */
export function ContainedNotice(props: {
  label: string;
  children: string;
  code?: string;
  outcome?: string;
}) {
  return (
    <small
      role="note"
      aria-label={props.label}
      data-error-code={props.code}
      data-vendo-notice={props.outcome ?? "contained"}
      style={noticeStyle}
    >
      {props.children}
    </small>
  );
}
