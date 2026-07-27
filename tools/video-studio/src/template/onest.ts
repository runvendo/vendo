import {continueRender, delayRender, staticFile} from 'remotion';

/**
 * The brand typeface, bundled — no font CDN, no network, ever.
 *
 * The bytes in `public/fonts/` are the SAME pinned Onest v9 variable subsets
 * the product itself ships: they were decoded straight out of
 * `packages/ui/src/chrome/onest-font.gen.ts` (which inlines them as data URIs
 * so a host needs no font setup). The film therefore renders the exact glyphs
 * the product renders, and a render works with the machine offline.
 *
 * Onest is SIL OFL 1.1 — packages/ui/ONEST-OFL.txt.
 */

/** Unicode ranges copied verbatim from packages/ui/scripts/build-onest-font.mjs. */
const SUBSETS = [
  {
    file: 'fonts/onest-latin.woff2',
    range:
      'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    file: 'fonts/onest-latin-ext.woff2',
    range:
      'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
] as const;

/** The weights the film actually sets, so the loader waits for all of them. */
const WEIGHTS = [400, 500, 600, 700, 800] as const;

export const ONEST_FAMILY = 'Onest, system-ui, -apple-system, sans-serif';

/** `font-display: block` — a swap would flash fallback metrics on frame one. */
export const ONEST_FACE_CSS = SUBSETS.map(
  (subset) => `@font-face {
  font-family: 'Onest';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url(${staticFile(subset.file)}) format('woff2');
  unicode-range: ${subset.range};
}`,
).join('\n');

let injected = false;

/**
 * Declare the faces and hold the render until the glyphs are rasterizable.
 *
 * Injected at module scope (not in an effect) for the same reason
 * `ensureChromeStyles()` is: an effect lands a frame late, and on camera that
 * is one unstyled flash. `delayRender` is what makes the wait deterministic —
 * Remotion will not capture frame one until `document.fonts` reports the
 * weights ready.
 */
export function ensureOnestFont(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.dataset.videoStudioOnest = '';
  style.textContent = ONEST_FACE_CSS;
  document.head.append(style);
  const handle = delayRender('rasterizing the bundled Onest font');
  Promise.all(WEIGHTS.map((weight) => document.fonts.load(`${weight} 16px Onest`)))
    .then(() => continueRender(handle))
    .catch(() => continueRender(handle));
}

ensureOnestFont();
