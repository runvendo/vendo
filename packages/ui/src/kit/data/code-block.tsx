/** CodeBlock — code or a raw payload, shown exactly as it came (W2 §The Kit).
 *  No highlighting (a parser is a dependency) and no copy button (the clipboard
 *  is a permission the jail does not have). */
import { font, t } from "../tokens.js";

export interface CodeBlockProps {
  /** The code / payload to show. */
  code?: string;
  /** Language label for the chip, e.g. "json". */
  language?: string;
}

const mono = "var(--vendo-mono-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";

export function CodeBlock({ code = "", language }: CodeBlockProps) {
  return (
    <div
      data-kit="CodeBlock"
      data-language={language}
      style={{
        ...font,
        position: "relative",
        border: `var(--vendo-border-width, 1px) solid ${t.border}`,
        borderRadius: t.radiusMedium,
        background: `var(--vendo-color-surface-raised, color-mix(in srgb, ${t.background} 60%, ${t.surface}))`,
        boxShadow: `var(--vendo-shadow-small, 0 1px 2px color-mix(in srgb, ${t.text} 6%, transparent))`,
        overflow: "hidden",
      }}
    >
      {language ? (
        <span
          style={{
            position: "absolute",
            insetInlineEnd: 10,
            insetBlockStart: 8,
            color: t.muted,
            fontSize: "0.68em",
            fontWeight: 650,
            letterSpacing: "0.09em",
            textTransform: "uppercase",
            userSelect: "none",
          }}
        >
          {language}
        </span>
      ) : null}
      <pre
        style={{
          margin: 0,
          padding: "var(--vendo-density-card-padding, 12px 14px)",
          overflowX: "auto",
          fontFamily: mono,
          fontSize: "0.85em",
          lineHeight: 1.55,
          tabSize: 2,
        }}
      >
        <code style={{ fontFamily: mono }}>{code}</code>
      </pre>
    </div>
  );
}
