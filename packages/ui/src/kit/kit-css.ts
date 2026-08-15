/**
 * The Kit's ONE stylesheet, and it carries nothing but pseudo-class state.
 *
 * Every themable pixel stays in each brick's inline `style`, because inline is
 * what survives the jail: an island paints inside a sandboxed `srcdoc` iframe
 * whose only inherited styling is the `--vendo-*` custom properties the host
 * posts in (`embedded-runtime.ts` `applyThemeVars`). That is also why `:hover`,
 * `:focus-visible` and `:active` were unreachable until this file — a style
 * attribute cannot express a pseudo-class, and there was no sheet to put one in.
 *
 * So the rule for what belongs here is exact: a STATE the inline style cannot
 * spell. Anything a theme owns — a color, a radius, a spacing step — stays
 * inline, and every value below still resolves to a `--vendo-*` token, so a
 * hover state can no more invent a color than a resting one can.
 */
import { t } from "./tokens.js";

/** The controls whose edge answers the pointer. */
const FIELDS = ['[data-kit="Input"]', '[data-kit="Textarea"]', '[data-kit="Select"]', '[data-kit="DatePicker"]'];

const hover = FIELDS.map((f) => `${f}:hover:not(:disabled)`).join(", ");
const focus = FIELDS.map((f) => `${f}:focus-visible`).join(", ");

/**
 * `!important` is not a shortcut here, it is the only thing that works.
 *
 * A brick paints its resting look in a `style` attribute, and an inline
 * declaration outranks every rule in every stylesheet for that same property —
 * specificity never enters into it. So a hover rule that sets `background` the
 * normal way loses to the inline `background` 100% of the time; browser-checked,
 * the first cut of this file changed nothing at all on hover while the focus
 * ring worked, because `outline` is the one property no brick sets inline.
 * Marking only the STATE declarations is what lets the resting style stay where
 * it has to be — inline, where the jail can see it.
 */
export const KIT_CSS = `
[data-kit="Button"][data-variant="primary"]:not([disabled]):hover { background: color-mix(in srgb, ${t.accent} 88%, ${t.text}) !important; }
[data-kit="Button"][data-variant="danger"]:not([disabled]):hover { background: color-mix(in srgb, ${t.danger} 88%, ${t.text}) !important; }
[data-kit="Button"][data-variant="secondary"]:not([disabled]):hover { background: ${t.surfaceRaised} !important; border-color: color-mix(in srgb, ${t.accent} 35%, ${t.border}) !important; }
[data-kit="Button"]:not([disabled]):active { transform: translateY(0.5px); }
${hover} { border-color: color-mix(in srgb, ${t.accent} 35%, ${t.border}) !important; }
[data-kit-close]:hover { background: ${t.surfaceRaised} !important; color: ${t.text} !important; }
[data-kit]:focus-visible, [data-kit-close]:focus-visible { outline: 2px solid ${t.accent}; outline-offset: 2px; }
${focus} { border-color: ${t.accent} !important; outline-offset: 0; }
[data-vendo-motion="reduced"] [data-kit="Button"]:active { transform: none; }
`.trim();

/** Inject the Kit stylesheet once, guarded exactly like `ensureChromeStyles`.
 *  Called on both surfaces the Kit paints on, and `document` means a different
 *  document on each: the host page's, and — from the jail runtime, which runs
 *  inside the frame — the island's own. */
export function ensureKitStyles(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-vendo-kit]")) return;
  const style = document.createElement("style");
  style.dataset.vendoKit = "";
  style.textContent = KIT_CSS;
  document.head.append(style);
}
