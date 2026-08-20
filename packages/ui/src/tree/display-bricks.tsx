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
import { SAFE_STYLE_PROPERTIES } from "@vendoai/apps/contract";
import type { CSSProperties, ReactNode } from "react";

export interface DisplayBrickProps {
  style?: CSSProperties;
  /** The class this brick paints with — the HOST's own, off a component the
   *  splitter ported out of real host source, so the port looks like what it was
   *  ported from. A node's own `className` is not it and never reaches the DOM:
   *  the renderer writes `hostClass` itself, after the props it binds and only
   *  for a `source: "ported"` node, so neither a model nor a slot can spell it.
   *
   *  Only the gauntlet stamps that source, and only off the DIALECT it graded the
   *  screen in (`apps` checking/component-screen.ts) — which a screen has no way
   *  to name. */
  hostClass?: string;
  children?: ReactNode;
}

/** The paint allowlist itself lives in the contract, beside the display tags,
 *  because the component screen's typings print the same list as the `style`
 *  type — one boundary, read from one place (`contract/kit/display.ts`). */
const ALLOWED_STYLE: ReadonlySet<string> = new Set(SAFE_STYLE_PROPERTIES);

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
  div: ({ style, hostClass, children }) => <div style={style} className={hostClass}>{children}</div>,
  span: ({ style, hostClass, children }) => <span style={style} className={hostClass}>{children}</span>,
  section: ({ style, hostClass, children }) => <section style={style} className={hostClass}>{children}</section>,
  article: ({ style, hostClass, children }) => <article style={style} className={hostClass}>{children}</article>,
  header: ({ style, hostClass, children }) => <header style={style} className={hostClass}>{children}</header>,
  footer: ({ style, hostClass, children }) => <footer style={style} className={hostClass}>{children}</footer>,
  aside: ({ style, hostClass, children }) => <aside style={style} className={hostClass}>{children}</aside>,
  h1: ({ style, hostClass, children }) => <h1 style={style} className={hostClass}>{children}</h1>,
  h2: ({ style, hostClass, children }) => <h2 style={style} className={hostClass}>{children}</h2>,
  h3: ({ style, hostClass, children }) => <h3 style={style} className={hostClass}>{children}</h3>,
  h4: ({ style, hostClass, children }) => <h4 style={style} className={hostClass}>{children}</h4>,
  h5: ({ style, hostClass, children }) => <h5 style={style} className={hostClass}>{children}</h5>,
  h6: ({ style, hostClass, children }) => <h6 style={style} className={hostClass}>{children}</h6>,
  p: ({ style, hostClass, children }) => <p style={style} className={hostClass}>{children}</p>,
  strong: ({ style, hostClass, children }) => <strong style={style} className={hostClass}>{children}</strong>,
  em: ({ style, hostClass, children }) => <em style={style} className={hostClass}>{children}</em>,
  small: ({ style, hostClass, children }) => <small style={style} className={hostClass}>{children}</small>,
  code: ({ style, hostClass, children }) => <code style={style} className={hostClass}>{children}</code>,
  blockquote: ({ style, hostClass, children }) => <blockquote style={style} className={hostClass}>{children}</blockquote>,
  ul: ({ style, hostClass, children }) => <ul style={style} className={hostClass}>{children}</ul>,
  ol: ({ style, hostClass, children }) => <ol style={style} className={hostClass}>{children}</ol>,
  li: ({ style, hostClass, children }) => <li style={style} className={hostClass}>{children}</li>,
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
