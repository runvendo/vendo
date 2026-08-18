/**
 * The display bricks' React half — the tags `DISPLAY_SPECS` names
 * (`packages/apps/src/contract/kit/display.ts`), keyed by tag. A drift test pins
 * the two in step, exactly as `KIT_COMPONENTS` is pinned to `KIT_SPECS`.
 *
 * Each brick is written out by hand and destructures exactly `style`,
 * `hostClass` and `children`. That is the whole containment of the prop surface:
 * there is no spread, so `className`, `id`, `onClick`, `data-*`, `aria-*` and
 * `dangerouslySetInnerHTML` cannot arrive — not because a list refuses them, but
 * because nothing carries them through.
 */
import type { CSSProperties, ReactNode } from "react";

export interface DisplayBrickProps {
  style?: CSSProperties;
  /** The class this brick paints with — the HOST's own, off a component the
   *  splitter ported out of real host source, so the port looks like what it was
   *  ported from. A node's own `className` is not it and never reaches the DOM:
   *  the renderer writes `hostClass` itself, after the props it binds and only
   *  for a `source: "ported"` node, so neither a model nor a slot can spell it.
   *
   *  UNREACHABLE TODAY — nothing ever arrives here. Nothing stamps
   *  `source: "ported"` on a node: `flattenTree`'s second argument is the only
   *  thing that could, and the engine door it is called through takes ONE
   *  argument (`tree/screen-engine.ts:85`), as do all three production callers.
   *  So the renderer's test is always false and every brick paints
   *  `className={undefined}`. Kept as the starting point if this is ever
   *  funded; do not read it as working. */
  hostClass?: string;
  children?: ReactNode;
}

/**
 * What a screen may paint with is a DEFAULT-DENY property allowlist and NOTHING
 * ELSE: `safeStyle` keeps a declaration iff its property is named here, whatever
 * its value. No value is ever inspected — so there is no CSS spelling for a model
 * to bypass. The list holds only properties that cannot fetch: a `color` takes a
 * URL nowhere, but `background`, `backgroundImage`, `filter`, `backdropFilter`
 * and `cursor` all can (`url()`, `image-set()`), so they are simply absent and
 * drop by default alongside `maskImage`, `borderImage` and `content`. Themed fills
 * use `backgroundColor`; gradients/blur are not available to a raw brick (a
 * host-controlled kit token could reintroduce them later, out of scope here).
 * `position` is allowed: `SURFACE_CONTAINMENT` clips even `fixed`/`sticky` to the
 * box, so no value check is needed to hold a screen inside its surface.
 */
const ALLOWED_STYLE: ReadonlySet<string> = new Set([
  // layout
  "display", "flexDirection", "flexWrap", "flex", "flexGrow", "flexShrink", "flexBasis",
  "alignItems", "alignSelf", "justifyContent", "justifyItems", "justifySelf",
  "gap", "rowGap", "columnGap", "gridTemplateColumns", "gridTemplateRows",
  "gridColumn", "gridRow", "gridAutoFlow", "position", "inset", "top", "right", "bottom", "left",
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

/** The style a brick actually paints with: the model's, minus every declaration
 *  whose property is not on the allowlist. A pure key filter — no value is read,
 *  so there is no CSS parser and nothing to bypass. */
export function safeStyle(style: CSSProperties | undefined): CSSProperties | undefined {
  if (style === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(style).filter(([property]) => ALLOWED_STYLE.has(property)),
  );
}

export const DISPLAY_BRICKS: Record<string, (props: DisplayBrickProps) => ReactNode> = {
  div: ({ style, hostClass, children }) => <div style={safeStyle(style)} className={hostClass}>{children}</div>,
  span: ({ style, hostClass, children }) => <span style={safeStyle(style)} className={hostClass}>{children}</span>,
  section: ({ style, hostClass, children }) => <section style={safeStyle(style)} className={hostClass}>{children}</section>,
  header: ({ style, hostClass, children }) => <header style={safeStyle(style)} className={hostClass}>{children}</header>,
  footer: ({ style, hostClass, children }) => <footer style={safeStyle(style)} className={hostClass}>{children}</footer>,
  aside: ({ style, hostClass, children }) => <aside style={safeStyle(style)} className={hostClass}>{children}</aside>,
  h1: ({ style, hostClass, children }) => <h1 style={safeStyle(style)} className={hostClass}>{children}</h1>,
  h2: ({ style, hostClass, children }) => <h2 style={safeStyle(style)} className={hostClass}>{children}</h2>,
  h3: ({ style, hostClass, children }) => <h3 style={safeStyle(style)} className={hostClass}>{children}</h3>,
  h4: ({ style, hostClass, children }) => <h4 style={safeStyle(style)} className={hostClass}>{children}</h4>,
  h5: ({ style, hostClass, children }) => <h5 style={safeStyle(style)} className={hostClass}>{children}</h5>,
  h6: ({ style, hostClass, children }) => <h6 style={safeStyle(style)} className={hostClass}>{children}</h6>,
  p: ({ style, hostClass, children }) => <p style={safeStyle(style)} className={hostClass}>{children}</p>,
  strong: ({ style, hostClass, children }) => <strong style={safeStyle(style)} className={hostClass}>{children}</strong>,
  em: ({ style, hostClass, children }) => <em style={safeStyle(style)} className={hostClass}>{children}</em>,
  small: ({ style, hostClass, children }) => <small style={safeStyle(style)} className={hostClass}>{children}</small>,
  code: ({ style, hostClass, children }) => <code style={safeStyle(style)} className={hostClass}>{children}</code>,
  blockquote: ({ style, hostClass, children }) => <blockquote style={safeStyle(style)} className={hostClass}>{children}</blockquote>,
  ul: ({ style, hostClass, children }) => <ul style={safeStyle(style)} className={hostClass}>{children}</ul>,
  ol: ({ style, hostClass, children }) => <ol style={safeStyle(style)} className={hostClass}>{children}</ol>,
  li: ({ style, hostClass, children }) => <li style={safeStyle(style)} className={hostClass}>{children}</li>,
};

/**
 * A screen paints inside its own box and nowhere else. Capability-shaped, like
 * the property allowlist: `contain: paint` makes this element the containing
 * block for every fixed and absolutely positioned descendant, so `position:
 * fixed; width: 200vw` is held by the BOX — nothing had to read the word "fixed".
 */
export const SURFACE_CONTAINMENT: CSSProperties = {
  contain: "layout paint",
  overflow: "clip",
  position: "relative",
  isolation: "isolate",
};
