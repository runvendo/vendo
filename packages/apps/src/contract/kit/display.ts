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
