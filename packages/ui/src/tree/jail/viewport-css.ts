/**
 * Existing-agents polish — the stylesheet arm of the jail's viewport-height
 * normalization. An auto-sized jail iframe has no independent block viewport:
 * `100vh` resolves to whatever height the HOST set from the last content
 * measurement, so a viewport-tall block plus any content after it grows the
 * frame on every measure (browser-observed: generated dashboards ratcheting
 * to the 8192px cap, leaving a tall run of empty background in the embed).
 * The runtime already rewrites inline viewport block constraints; generated
 * islands that ship the same constraint in a `<style>` tag get the identical
 * treatment here: growing block sizes go content-sized, everything else —
 * including bounding `max-*` constraints — stays untouched.
 */

/** The viewport BLOCK units (vh/vb and their d/s/l variants), never vw/vi. */
const VIEWPORT_BLOCK_UNIT = /(?:d|s|l)?v(?:h|b)(?![a-z])/iu;

/** A growing block-size declaration: `height`/`block-size` and their `min-`
 *  forms, anchored so `max-height`/`line-height` never match. */
const BLOCK_SIZE_DECLARATION = /(^|[{;\s])(min-)?(height|block-size)(\s*:\s*)([^;}]+)/giu;

/** Rewrite viewport-relative block constraints in a stylesheet's text to
 *  their content-sized forms (`height: auto`, `min-height: 0`). Idempotent:
 *  a sheet without viewport block sizes comes back unchanged (identity). */
export function normalizeViewportBlockCss(css: string): string {
  BLOCK_SIZE_DECLARATION.lastIndex = 0;
  if (!BLOCK_SIZE_DECLARATION.test(css)) return css;
  return css.replace(
    BLOCK_SIZE_DECLARATION,
    (match, prefix: string, min: string | undefined, property: string, colon: string, value: string) => {
      if (!VIEWPORT_BLOCK_UNIT.test(value)) return match;
      const trailing = /\s$/u.test(value) ? value.slice(value.trimEnd().length) : "";
      return `${prefix}${min ?? ""}${property}${colon}${min === undefined ? "auto" : "0"}${trailing}`;
    },
  );
}
