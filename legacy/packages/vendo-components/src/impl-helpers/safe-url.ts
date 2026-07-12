/**
 * Returns the URL if it is a safe data:image URI, else undefined.
 * Remote (http/https) image loads are intentionally rejected: the sandbox CSP is
 * `img-src data:` (egress jail), so a remote src would render broken and is also an
 * exfiltration vector.
 */
export function allowlistUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  // Cap at 1 MB to reject pathological data-URL payloads
  if (trimmed.length > 1_000_000) return undefined;
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(trimmed)) return trimmed;
  return undefined;
}

/**
 * URL transform for react-markdown's `urlTransform` option.
 * For images (key="src"): allow only safe data:image via allowlistUrl.
 * For links (key="href"): allow only https and mailto.
 * All other URLs are dropped (return "").
 */
export function vendoUrlTransform(url: string, key: string): string {
  if (key === "src") {
    return allowlistUrl(url) ?? "";
  }
  if (key === "href") {
    const trimmed = url.trim();
    if (/^https:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
    return "";
  }
  return "";
}
