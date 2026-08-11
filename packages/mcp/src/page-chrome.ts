import {
  themeCssVariables,
  type VendoTheme,
} from "@vendoai/apps/contract";

/**
 * The chrome every door-rendered page shares: the host's theme as `--vendo-*`
 * variables, HTML escaping, and the response headers. Extracted so the consent
 * page and the connect page cannot drift — in particular so there is exactly
 * ONE definition of the door's CSP posture (no scripts, no network, no framing)
 * instead of two copies to keep in sync by hand.
 */

/** The style-attribute serialization of core's one theme→CSS-variable mapping.
 * It lives in core rather than ui because `scripts/dependency-guard.mjs`
 * restricts `@vendoai/mcp` to `@vendoai/core`, so ui is not importable here. */
export function vendoThemeStyle(theme: VendoTheme): string {
  return Object.entries(themeCssVariables(theme)).map(([name, value]) => `${name}:${value}`).join(";");
}

/** The theme as a ready-to-inline `style` attribute (empty when unthemed). */
export function themeAttribute(theme?: VendoTheme): string {
  return theme === undefined ? "" : ` style="${escapeHtml(vendoThemeStyle(theme))}"`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

/**
 * A door-rendered HTML response. The CSP is the whole security posture of these
 * pages: no scripts at ALL (`default-src 'none'` with only inline styles
 * allowed), so neither page can be turned into an exfiltration surface by a
 * hostile value that slipped past escaping. `formAction` opens `form-action`
 * for the consent page's POST; a page with no form keeps it closed.
 */
export function htmlPage(html: string, options: { formAction?: "self" } = {}): Response {
  const formAction = options.formAction === "self" ? "'self'" : "'none'";
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "content-security-policy":
        `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
