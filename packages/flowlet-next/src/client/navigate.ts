/**
 * Reserved navigation action from the next/link + next/navigation shims,
 * handled CLIENT-SIDE by SandboxStage — never sent to the policy-governed
 * /action route.
 */
export const NAVIGATE_ACTION = "flowlet.navigate";

/**
 * A remixed component may only navigate to same-app paths. Reject external
 * URLs, protocol-relative (`//host`), `javascript:`/`mailto:` schemes, and
 * relative paths — a generated view must not send the user off-site or run a
 * scheme handler.
 */
export function isSafeAppPath(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0) return false;
  if (href.startsWith("//")) return false; // protocol-relative → external
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // has a scheme
  return href.startsWith("/"); // absolute in-app path only
}
