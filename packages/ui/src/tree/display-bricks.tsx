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
 * What a screen may paint with is a DEFAULT-DENY property allowlist, not a
 * value denylist: a property not named here is dropped whatever its value, so a
 * fetching property nobody predicted (`maskImage`, `borderImage`, `content`) is
 * gone by default. Every name here is inert — none can carry a URL — so it
 * passes with any value; the properties that CAN fetch are handled below.
 */
const ALLOWED_STYLE: ReadonlySet<string> = new Set([
  // layout
  "display", "flexDirection", "flexWrap", "flex", "flexGrow", "flexShrink", "flexBasis",
  "alignItems", "alignSelf", "justifyContent", "justifyItems", "justifySelf",
  "gap", "rowGap", "columnGap", "gridTemplateColumns", "gridTemplateRows",
  "gridColumn", "gridRow", "gridAutoFlow", "inset", "top", "right", "bottom", "left",
  "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "overflow", "overflowX", "overflowY", "boxSizing",
  // spacing
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  // color
  "color", "backgroundColor", "borderColor", "outlineColor",
  // typography
  "fontSize", "fontWeight", "fontStyle", "fontFamily", "lineHeight", "letterSpacing",
  "textAlign", "textTransform", "textDecoration", "textOverflow", "whiteSpace",
  "wordBreak", "textWrap", "fontVariantNumeric",
  // border + shape (borderImage* is deliberately absent — it fetches)
  "border", "borderWidth", "borderStyle", "borderRadius",
  "borderTop", "borderRight", "borderBottom", "borderLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
  "outline", "outlineWidth", "outlineStyle", "outlineOffset",
  // effects
  "opacity", "boxShadow", "transform", "transformOrigin",
  "transition", "transitionProperty", "transitionDuration", "transitionTimingFunction",
]);

/** `position` can fold a screen out of its box, so only the in-flow values
 *  survive — `fixed`/`sticky` would escape `SURFACE_CONTAINMENT` and are dropped. */
const POSITION_KEEP: ReadonlySet<string> = new Set(["static", "relative", "absolute"]);

/**
 * The dual-use properties: each holds both an inert value (a gradient, a blur)
 * and a fetching one (`url()`, `image-set()`). Kept, but only when every CSS
 * function its value calls is on the property's list — `cursor` calls none
 * (keyword cursors only), so a `url()` cursor is dropped like any other fetch.
 */
const GRADIENTS = ["linear-gradient", "radial-gradient", "conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient"];
const FILTERS = ["blur", "brightness", "contrast", "grayscale", "hue-rotate",
  "invert", "opacity", "saturate", "sepia", "drop-shadow"];
const VALUE_RESTRICTED: Record<string, ReadonlySet<string>> = {
  background: new Set(GRADIENTS),
  backgroundImage: new Set(GRADIENTS),
  filter: new Set(FILTERS),
  backdropFilter: new Set(FILTERS),
  cursor: new Set(),
};

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

/** Every CSS function a value calls, escapes resolved the way the browser
 *  resolves them so `\75 rl(` reads as `url(`. Vendor spellings ride the hyphen
 *  (`-webkit-image-set`); one name off the property's list drops the whole
 *  declaration. */
const FUNCTION = /([-\w]+)\s*\(/gu;
const functionsCalled = (value: string): string[] =>
  [...unescaped(preprocessed(value)).matchAll(FUNCTION)].map(([, name]) => name!.toLowerCase());

const keep = (property: string, value: unknown): boolean => {
  if (property === "position") return POSITION_KEEP.has(String(value).trim().toLowerCase());
  const allowed = VALUE_RESTRICTED[property];
  if (allowed !== undefined) return functionsCalled(String(value)).every((name) => allowed.has(name));
  return ALLOWED_STYLE.has(property);
};

/** The style a brick actually paints with: the model's, minus every declaration
 *  the allowlist does not admit. Dropping the DECLARATION (never rewriting the
 *  value) keeps this a filter with no CSS parser in it. */
export function safeStyle(style: CSSProperties | undefined): CSSProperties | undefined {
  if (style === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(style).filter(([property, value]) => keep(property, value)),
  );
}

export const DISPLAY_BRICKS: Record<string, (props: DisplayBrickProps) => ReactNode> = {
  div: ({ style, children }) => <div style={safeStyle(style)}>{children}</div>,
  span: ({ style, children }) => <span style={safeStyle(style)}>{children}</span>,
  section: ({ style, children }) => <section style={safeStyle(style)}>{children}</section>,
  header: ({ style, children }) => <header style={safeStyle(style)}>{children}</header>,
  footer: ({ style, children }) => <footer style={safeStyle(style)}>{children}</footer>,
  aside: ({ style, children }) => <aside style={safeStyle(style)}>{children}</aside>,
  h1: ({ style, children }) => <h1 style={safeStyle(style)}>{children}</h1>,
  h2: ({ style, children }) => <h2 style={safeStyle(style)}>{children}</h2>,
  h3: ({ style, children }) => <h3 style={safeStyle(style)}>{children}</h3>,
  h4: ({ style, children }) => <h4 style={safeStyle(style)}>{children}</h4>,
  h5: ({ style, children }) => <h5 style={safeStyle(style)}>{children}</h5>,
  h6: ({ style, children }) => <h6 style={safeStyle(style)}>{children}</h6>,
  p: ({ style, children }) => <p style={safeStyle(style)}>{children}</p>,
  strong: ({ style, children }) => <strong style={safeStyle(style)}>{children}</strong>,
  em: ({ style, children }) => <em style={safeStyle(style)}>{children}</em>,
  small: ({ style, children }) => <small style={safeStyle(style)}>{children}</small>,
  code: ({ style, children }) => <code style={safeStyle(style)}>{children}</code>,
  blockquote: ({ style, children }) => <blockquote style={safeStyle(style)}>{children}</blockquote>,
  ul: ({ style, children }) => <ul style={safeStyle(style)}>{children}</ul>,
  ol: ({ style, children }) => <ol style={safeStyle(style)}>{children}</ol>,
  li: ({ style, children }) => <li style={safeStyle(style)}>{children}</li>,
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
