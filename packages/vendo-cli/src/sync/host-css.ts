/**
 * Host CSS for the sandbox. Compiled from SOURCE during sync (never
 * `.next/static/css`, which does not exist when `prebuild` runs before
 * `next build`), then sanitized so it contains ZERO fetchable URLs — the
 * sandbox CSP allows only `data:` for images/fonts and does not change.
 *
 * Sanitize rules: `url(...)` / `image-set(...)` referencing http(s)/root/
 * relative paths are dropped; `@import` is dropped; `data:` URLs are kept.
 * Every drop is reported. (Small-asset data-inlining is a future refinement;
 * dropping is the safe default and keeps zero fetchable URLs by construction.)
 */

// Fresh regex instances per call — global-flag `.test()`/`.replace()` share
// `lastIndex`, so reusing a module-level literal across calls corrupts state.
// `@import` in any form (including `@import/**/"x";` after comment removal).
const atImport = () => /@import\b[^;]*;?/gi;
// ANY url(...) whose target is not a data: URI — quoted, unquoted, spaced. The
// negative lookahead skips `data:` (already normalized for whitespace/escapes).
const fetchableUrl = () => /url\(\s*(['"]?)\s*(?!data:)[^)]*?\1\s*\)/gi;
// image-set()/-webkit-image-set() take BARE string URLs (not url()) — drop the
// whole function call.
const imageSet = () => /(?:-webkit-)?image-set\([^)]*\)/gi;
// Any external URL literal that survived the structured passes (belt and
// suspenders): http(s) and protocol-relative refs anywhere in the text.
const externalRef = () => /(?:https?:|\/\/)[^\s'")]+/gi;
// CSS comments — stripped FIRST so `u/**/rl(...)`-style hiding can't survive.
const cssComment = () => /\/\*[\s\S]*?\*\//g;
// CSS hex escapes (`\75` = u, `\5c` = \) — decoded before matching so an
// escaped `url` or `@import` cannot slip through the textual match.
const cssHexEscape = () => /\\([0-9a-fA-F]{1,6})\s?/g;

function decodeEscapes(css: string): string {
  return css.replace(cssHexEscape(), (_m, hex) => {
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/**
 * Replace every kept `url(data:...)` token with an opaque placeholder so NO
 * later pass (fetchable-url, external-ref) can corrupt a payload containing
 * `)` (quoted SVG) or `//` (base64). A small quote/escape-aware scanner — a
 * regex stopping at the first `)` truncates quoted data URLs. Returns the
 * masked string plus the ordered original tokens for restoration.
 */
function maskDataUrls(css: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const lower = css.toLowerCase();
  let out = "";
  let i = 0;
  while (i < css.length) {
    const start = lower.indexOf("url(", i);
    if (start === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, start);
    // Scan to the matching ')', honoring a quoted argument whose payload may
    // itself contain ')'.
    let j = start + 4;
    while (j < css.length && /\s/.test(css[j]!)) j++;
    const quote = css[j] === '"' || css[j] === "'" ? css[j]! : "";
    let k = j + (quote ? 1 : 0);
    if (quote) {
      while (k < css.length && css[k] !== quote) k += css[k] === "\\" ? 2 : 1;
      k++; // past the closing quote
    }
    while (k < css.length && css[k] !== ")") k++;
    if (k >= css.length) {
      out += css.slice(start); // unterminated url( — leave verbatim
      break;
    }
    const token = css.slice(start, k + 1);
    const isData = css.slice(j + (quote ? 1 : 0)).replace(/^\s+/, "").toLowerCase().startsWith("data:");
    out += isData ? `__vendo-data-${tokens.push(token) - 1}__` : token;
    i = k + 1;
  }
  return { masked: out, tokens };
}

export interface SanitizeResult {
  css: string;
  dropped: string[];
}

/**
 * Reduce host CSS to ZERO fetchable URLs (the sandbox CSP allows only `data:`
 * for images/fonts and does not change). Comments and hex escapes are decoded
 * first so nothing can hide `url(`/`@import` from the matcher; then every
 * `@import` and every non-`data:` `url()` (covers `image-set`, `@font-face`,
 * masks, cursors, backgrounds — all use `url()`) is dropped. `hasFetchableUrl`
 * runs the SAME normalization, so the test guard cannot be fooled by a form
 * the sanitizer normalized away.
 */
export function sanitizeCss(css: string): SanitizeResult {
  const dropped: string[] = [];
  // Normalize first: strip comments, decode escapes.
  let out = decodeEscapes(css.replace(cssComment(), ""));
  // Mask kept data: URLs up front so NO pass below can corrupt a payload
  // containing `)` (quoted SVG) or `//` (base64); restore verbatim at the end.
  const { masked, tokens } = maskDataUrls(out);
  out = masked;
  out = out.replace(atImport(), (match) => {
    dropped.push(match.trim());
    return "/* vendo: import rule dropped */";
  });
  out = out.replace(imageSet(), (match) => {
    dropped.push(match.trim());
    return "none";
  });
  out = out.replace(fetchableUrl(), (match) => {
    dropped.push(match.trim());
    return "none";
  });
  // Final catch-all: neutralize any external URL literal still present (e.g. a
  // bare string in a property we don't structurally understand).
  out = out.replace(externalRef(), (match) => {
    dropped.push(match.trim());
    return "";
  });
  out = out.replace(/__vendo-data-(\d+)__/g, (_m, i) => tokens[Number(i)]!);
  return { css: out, dropped };
}

/** True when `css`, after the same normalization, still has any fetchable URL. */
export function hasFetchableUrl(css: string): boolean {
  // Same normalization + data:-URL masking as sanitizeCss, so the guard cannot
  // be fooled by a form the sanitizer normalized away, nor false-positive on a
  // `//` inside a kept data: payload.
  const normalized = maskDataUrls(decodeEscapes(css.replace(cssComment(), ""))).masked;
  return (
    fetchableUrl().test(normalized) ||
    atImport().test(normalized) ||
    imageSet().test(normalized) ||
    externalRef().test(normalized)
  );
}
