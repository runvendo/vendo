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
 * What a screen may paint with is a DEFAULT-DENY property allowlist and NOTHING
 * ELSE: `safeStyle` keeps a declaration iff its property is named here, whatever
 * its value. No value is ever inspected — so there is no CSS spelling for a model
 * to bypass. The list holds only properties that cannot fetch: a `color` takes a
 * URL nowhere, but `background`, `backgroundImage`, `filter`, `backdropFilter`
 * and `cursor` all can (`url()`, `image-set()`), so they are simply absent and
 * drop by default alongside `maskImage`, `borderImage` and `content`. Themed fills
 * use `backgroundColor`; gradients/blur are not available to a screen (a
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

/** The style a node actually paints with: the model's, minus every declaration
 *  whose property is not on the allowlist. A pure key filter — no value is read,
 *  so there is no CSS parser and nothing to bypass. */
export function safeStyle(style: CSSProperties | null | undefined): CSSProperties | undefined {
  if (style === undefined || style === null) return undefined;
  return Object.fromEntries(
    Object.entries(style).filter(([property]) => ALLOWED_STYLE.has(property)),
  );
}

/**
 * THE DOOR — a node's bound props as it may paint with them. The renderer calls
 * this wherever model-written props become a component's props, so ONE list
 * covers every node: a brick, a Kit component and a host component alike. It has
 * to be here rather than inside each implementation, because a Kit root MERGES
 * `style` onto its own (`<article style={{ ...theme, ...style }}>`) — filtered
 * only in the bricks, `Card` painted the `backgroundImage` a `<div>` may not.
 */
export function safeProps(props: Record<string, unknown>): Record<string, unknown> {
  return "style" in props ? { ...props, style: safeStyle(props.style as CSSProperties) } : props;
}

export const DISPLAY_BRICKS: Record<string, (props: DisplayBrickProps) => ReactNode> = {
  div: ({ style, children }) => <div style={style}>{children}</div>,
  span: ({ style, children }) => <span style={style}>{children}</span>,
  section: ({ style, children }) => <section style={style}>{children}</section>,
  header: ({ style, children }) => <header style={style}>{children}</header>,
  footer: ({ style, children }) => <footer style={style}>{children}</footer>,
  aside: ({ style, children }) => <aside style={style}>{children}</aside>,
  h1: ({ style, children }) => <h1 style={style}>{children}</h1>,
  h2: ({ style, children }) => <h2 style={style}>{children}</h2>,
  h3: ({ style, children }) => <h3 style={style}>{children}</h3>,
  h4: ({ style, children }) => <h4 style={style}>{children}</h4>,
  h5: ({ style, children }) => <h5 style={style}>{children}</h5>,
  h6: ({ style, children }) => <h6 style={style}>{children}</h6>,
  p: ({ style, children }) => <p style={style}>{children}</p>,
  strong: ({ style, children }) => <strong style={style}>{children}</strong>,
  em: ({ style, children }) => <em style={style}>{children}</em>,
  small: ({ style, children }) => <small style={style}>{children}</small>,
  code: ({ style, children }) => <code style={style}>{children}</code>,
  blockquote: ({ style, children }) => <blockquote style={style}>{children}</blockquote>,
  ul: ({ style, children }) => <ul style={style}>{children}</ul>,
  ol: ({ style, children }) => <ol style={style}>{children}</ol>,
  li: ({ style, children }) => <li style={style}>{children}</li>,
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
