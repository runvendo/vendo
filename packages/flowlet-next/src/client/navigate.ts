/**
 * Reserved navigation action from the next/link + next/navigation shims,
 * handled CLIENT-SIDE by SandboxStage — never sent to the policy-governed
 * /action route.
 */
export const NAVIGATE_ACTION = "flowlet.navigate";

// Control chars (incl. tab/newline the browser strips before resolving) and
// backslash (browsers treat `/\evil.com` as protocol-relative) are all
// origin-escape vectors — reject any href containing them.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * A remixed component may only navigate to same-app paths. Reject external
 * URLs, protocol-relative (`//host`), scheme handlers, and anything a browser
 * would resolve to a different origin.
 *
 * Layered (Codex review): drop control chars/backslash, require a leading `/`
 * that is not `//`, THEN confirm the URL actually resolves to the current
 * origin — the parse is the real guard; the string checks stop obvious tricks.
 */
export function isSafeAppPath(href: unknown, origin?: string): href is string {
  if (typeof href !== "string" || href.length === 0) return false;
  if (UNSAFE_CHARS.test(href)) return false;
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "http://localhost");
  try {
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
