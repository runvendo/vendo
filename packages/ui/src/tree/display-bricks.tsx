/**
 * The display bricks' React half — the tags `DISPLAY_SPECS` names
 * (`packages/apps/src/contract/kit/display.ts`), keyed by tag. A drift test pins
 * the two in step, exactly as `KIT_COMPONENTS` is pinned to `KIT_SPECS`.
 *
 * Each brick is written out by hand and destructures exactly `style` and
 * `children`. That is the whole containment of the prop surface: there is no
 * spread, so `className`, `id`, `onClick`, `data-*`, `aria-*` and
 * `dangerouslySetInnerHTML` cannot arrive — not because a list refuses them, but
 * because nothing carries them through.
 */
import type { CSSProperties, ReactNode } from "react";

export interface DisplayBrickProps {
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * A style value that would make the browser FETCH. The only content the trusted
 * side looks at, and it looks for a capability (a request leaves the page), not
 * for meaning: `background: url(https://evil/x)` is a beacon whatever the URL
 * says, and a screen has no network. `\b` catches the vendor spellings
 * (`-webkit-image-set(`) and spares the functions that merely end in the same
 * letters (`blur(`).
 */
const FETCHES = /\b(?:url|src|image-set)\s*\(/iu;

/**
 * A CSS escape: `\` then 1–6 hex digits with one trailing whitespace consumed,
 * or `\` then a literal character. The tokenizer unescapes BEFORE it decides
 * what a token is, so `\75 rl(` is the function `url(` however the raw string
 * reads — and `var()` substitutes whole tokens, so a custom property carries the
 * spelling through intact.
 */
const ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|(.))/giu;

/**
 * CSS input preprocessing (Syntax §3.3), the stage that runs BEFORE any escape
 * is read: CRLF, a lone CR and a form feed each collapse to ONE newline, and
 * NUL and lone surrogates become the replacement character. That first stage is
 * why `\75` + CRLF is `u` + a single newline by the time the escape claims its
 * one trailing whitespace — leaving `url(`.
 */
const preprocessed = (value: string): string =>
  value.replace(/\r\n?|\f/gu, "\n").replace(/[\0\ud800-\udfff]/gu, "�");

/** The escapes resolved, for the DECISION only — the brick still paints the
 *  original value. Code points past the Unicode range are the tokenizer's
 *  replacement character, not a throw. */
const unescaped = (value: string): string =>
  value.replace(ESCAPE, (_, hex: string | undefined, literal: string) =>
    hex === undefined ? literal
      : Number.parseInt(hex, 16) > 0x10ffff ? "�"
        : String.fromCodePoint(Number.parseInt(hex, 16)));

/** The style a brick actually paints with: the model's, minus any declaration
 *  that would fetch once its escapes read the way the browser reads them.
 *  Dropping the DECLARATION (not rewriting the value) keeps this a filter with
 *  no parser in it. */
export function withoutFetchableUrls(style: CSSProperties | undefined): CSSProperties | undefined {
  if (style === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => !FETCHES.test(unescaped(preprocessed(String(value))))),
  );
}

export const DISPLAY_BRICKS: Record<string, (props: DisplayBrickProps) => ReactNode> = {
  div: ({ style, children }) => <div style={withoutFetchableUrls(style)}>{children}</div>,
  span: ({ style, children }) => <span style={withoutFetchableUrls(style)}>{children}</span>,
  section: ({ style, children }) => <section style={withoutFetchableUrls(style)}>{children}</section>,
  header: ({ style, children }) => <header style={withoutFetchableUrls(style)}>{children}</header>,
  footer: ({ style, children }) => <footer style={withoutFetchableUrls(style)}>{children}</footer>,
  aside: ({ style, children }) => <aside style={withoutFetchableUrls(style)}>{children}</aside>,
  h1: ({ style, children }) => <h1 style={withoutFetchableUrls(style)}>{children}</h1>,
  h2: ({ style, children }) => <h2 style={withoutFetchableUrls(style)}>{children}</h2>,
  h3: ({ style, children }) => <h3 style={withoutFetchableUrls(style)}>{children}</h3>,
  h4: ({ style, children }) => <h4 style={withoutFetchableUrls(style)}>{children}</h4>,
  h5: ({ style, children }) => <h5 style={withoutFetchableUrls(style)}>{children}</h5>,
  h6: ({ style, children }) => <h6 style={withoutFetchableUrls(style)}>{children}</h6>,
  p: ({ style, children }) => <p style={withoutFetchableUrls(style)}>{children}</p>,
  strong: ({ style, children }) => <strong style={withoutFetchableUrls(style)}>{children}</strong>,
  em: ({ style, children }) => <em style={withoutFetchableUrls(style)}>{children}</em>,
  small: ({ style, children }) => <small style={withoutFetchableUrls(style)}>{children}</small>,
  code: ({ style, children }) => <code style={withoutFetchableUrls(style)}>{children}</code>,
  blockquote: ({ style, children }) => <blockquote style={withoutFetchableUrls(style)}>{children}</blockquote>,
  ul: ({ style, children }) => <ul style={withoutFetchableUrls(style)}>{children}</ul>,
  ol: ({ style, children }) => <ol style={withoutFetchableUrls(style)}>{children}</ol>,
  li: ({ style, children }) => <li style={withoutFetchableUrls(style)}>{children}</li>,
};

/**
 * A screen paints inside its own box and nowhere else. Capability-shaped, like
 * the fetch filter: `contain: paint` makes this element the containing block for
 * every fixed and absolutely positioned descendant, so `position: fixed;
 * width: 200vw` is held by the BOX — nothing had to read the word "fixed".
 */
export const SURFACE_CONTAINMENT: CSSProperties = {
  contain: "layout paint",
  overflow: "clip",
  position: "relative",
  isolation: "isolate",
};
