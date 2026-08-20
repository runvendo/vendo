/**
 * The DISPLAY BRICKS — the display-only HTML a screen may write, beside the Kit.
 *
 * The Kit is the vocabulary of BEHAVIOR: it sorts, formats, validates and calls
 * tools. These are the vocabulary of ARRANGEMENT, and they carry no behavior at
 * all: children and an inline `style`, nothing else. No `className`, no `id`, no
 * events, no `data-*`, no `aria-*`, no `dangerouslySetInnerHTML` — the React
 * implementations (`packages/ui/src/tree/display-bricks.tsx`) take exactly two
 * props per tag, so a prop that is not one of the two cannot arrive by spreading.
 *
 * Free CSS is safe because containment is CAPABILITY-shaped, never
 * content-shaped: the surface root paints inside its own box
 * (`SURFACE_CONTAINMENT`) so no declaration can reach host chrome, and the one
 * trusted-side filter drops the style values that would FETCH (`url()`, `src()`,
 * `image-set()`). Nothing reads a style for meaning; the LLM judge owns quality.
 */

/** One display tag. The name IS the tag — there are no props to describe. */
export interface DisplayTagSpec {
  readonly name: string;
  readonly summary: string;
}

export const DISPLAY_SPECS: readonly DisplayTagSpec[] = [
  { name: "div", summary: "A generic box. The default when nothing more specific fits." },
  { name: "span", summary: "A generic inline run, inside a line of text." },
  { name: "section", summary: "A themed region of the screen." },
  { name: "article", summary: "A self-contained piece of content — a card, a post." },
  { name: "header", summary: "The top band of a screen or section." },
  { name: "footer", summary: "The bottom band of a screen or section." },
  { name: "aside", summary: "Content beside the main flow — a sidebar or a note." },
  { name: "h1", summary: "The screen's title." },
  { name: "h2", summary: "A section heading." },
  { name: "h3", summary: "A sub-section heading." },
  { name: "h4", summary: "A fourth-level heading." },
  { name: "h5", summary: "A fifth-level heading." },
  { name: "h6", summary: "A sixth-level heading." },
  { name: "p", summary: "A paragraph of prose." },
  { name: "strong", summary: "Text that matters more than what surrounds it." },
  { name: "em", summary: "Emphasized text." },
  { name: "small", summary: "Fine print." },
  { name: "code", summary: "An identifier or literal, in the mono face." },
  { name: "blockquote", summary: "A quotation." },
  { name: "ul", summary: "An unordered list." },
  { name: "ol", summary: "An ordered list." },
  { name: "li", summary: "One item in a list." },
];

/** The tags, as the renderer, the typings and the checks read them. */
export const DISPLAY_TAG_NAMES: readonly string[] = DISPLAY_SPECS.map((spec) => spec.name);

/**
 * What a screen may paint with is a DEFAULT-DENY property allowlist and NOTHING
 * ELSE: a declaration survives iff its property is named here, whatever its
 * value. No value is ever inspected — so there is no CSS spelling for a model to
 * bypass. The list holds only properties that cannot fetch: a `color` takes a
 * URL nowhere, but `background`, `backgroundImage`, `filter`, `backdropFilter`
 * and `cursor` all can (`url()`, `image-set()`), so they are simply absent and
 * drop by default alongside `maskImage`, `borderImage` and `content`. Themed
 * fills use `backgroundColor`; gradients/blur are not available to a screen (a
 * host-controlled kit token could reintroduce them later, out of scope here).
 * `position` is allowed: the surface box clips even `fixed`/`sticky` to itself,
 * so no value check is needed to hold a screen inside its surface.
 *
 * It lives HERE, beside the tags, because BOTH sides read it and a second copy
 * of a security boundary is the copy that drifts: `@vendoai/ui` filters every
 * node's style through it at paint (`safeStyle`), and the component screen's
 * typings print it as the `style` type, so a property this list does not name is
 * a type error at check time rather than a declaration that silently vanishes.
 */
export const SAFE_STYLE_PROPERTIES: readonly string[] = [
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
];
