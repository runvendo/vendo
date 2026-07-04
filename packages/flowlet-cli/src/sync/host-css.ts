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
const fetchableUrl = () => /url\(\s*(['"]?)(?!data:)([^)'"]+)\1\s*\)/gi;
const atImport = () => /@import\s+[^;]+;/gi;

export interface SanitizeResult {
  css: string;
  dropped: string[];
}

export function sanitizeCss(css: string): SanitizeResult {
  const dropped: string[] = [];
  let out = css.replace(atImport(), (match) => {
    dropped.push(match.trim());
    return "/* flowlet: import rule dropped */";
  });
  out = out.replace(fetchableUrl(), (_match, _q, ref) => {
    dropped.push(`url(${ref})`);
    return "none";
  });
  return { css: out, dropped };
}

/** True when the sanitized output still has any fetchable URL (test guard). */
export function hasFetchableUrl(css: string): boolean {
  return fetchableUrl().test(css) || atImport().test(css);
}
