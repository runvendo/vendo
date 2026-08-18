/** CodeBlock — code or a raw payload, shown exactly as it came (W2 §The Kit).
 *  No highlighting (a parser is a dependency) and no copy button (the clipboard
 *  is a permission the jail does not have). */
import { font, hairline, microLabel, t, type KitStyled } from "../tokens.js";

export interface CodeBlockProps extends KitStyled {
  /** The code / payload to show. */
  code?: string;
  /** Language label for the chip, e.g. "json". */
  language?: string;
  /** Soft-wrap long lines instead of scrolling them sideways — what a prose-ish
   *  payload (an error message, a log line) wants, where code wants the scroll. */
  wrap?: boolean;
  /** Cap the block's height in px. Past it the block scrolls; without it a
   *  2,000-line payload pushes everything after it below the fold. */
  maxHeight?: number;
}

export function CodeBlock({ code = "", language, wrap, maxHeight, style }: CodeBlockProps) {
  return (
    <div
      data-kit="CodeBlock"
      data-language={language}
      style={{
        ...font,
        position: "relative",
        border: hairline,
        borderRadius: t.radiusMedium,
        background: t.surfaceRaised,
        overflow: "hidden",
        // A `pre` never wraps, so its longest line is the block's min-content —
        // and min-content propagates up through every panel around it, pushing
        // the whole layout off a narrow frame with nothing to scroll (a 480px
        // benchmark screen lost its assertion line that way). `overflow` on the
        // block does not stop that: only a flex/grid ITEM's automatic minimum
        // size is zeroed by it, and the block is usually neither. One grid track
        // floored at 0 is: the block still ASKS for its max-content, and accepts
        // any width down to nothing — so the `pre` below scrolls instead, or
        // reflows when `wrap` is on. The floor is what makes EITHER possible, and
        // `wrap` is per-instance, so the block that has to survive the 480px
        // frame is the one nobody passed it to.
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        ...style,
      }}
    >
      {language ? (
        <span
          style={{
            ...microLabel,
            position: "absolute",
            insetInlineEnd: 10,
            insetBlockStart: 8,
            fontSize: "0.68em",
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
          // `pre-wrap` alone breaks at whitespace, and a payload is routinely ONE
          // unbroken token (a base64 blob, a 400-char JSON string) — which would
          // overflow the wrap it was asked for.
          whiteSpace: wrap ? "pre-wrap" : undefined,
          overflowWrap: wrap ? "anywhere" : undefined,
          maxHeight,
          overflowY: maxHeight === undefined ? undefined : "auto",
          fontFamily: t.monoFamily,
          fontSize: "0.85em",
          lineHeight: 1.55,
          tabSize: 2,
        }}
      >
        <code style={{ fontFamily: t.monoFamily }}>{code}</code>
      </pre>
    </div>
  );
}
