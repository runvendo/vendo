import type { VendoTheme } from "@vendoai/core";

/**
 * The chrome every door-rendered page shares: the host's theme as `--vendo-*`
 * variables, HTML escaping, and the response headers. Extracted so the consent
 * page and the connect page cannot drift — in particular so there is exactly
 * ONE definition of the door's CSP posture (no scripts, no network, no framing)
 * instead of two copies to keep in sync by hand.
 */

/** Intentionally mirrors `@vendoai/ui`'s theme-token mapping (`packages/ui/src/theme.ts`)
 * rather than importing it: `scripts/dependency-guard.mjs` restricts `@vendoai/mcp` to
 * `@vendoai/core` only, so ui is not an importable dependency here. There is no shared
 * home for this mapping today — core does not carry it, and ui does not re-export it from
 * core — so any change to ui's theme→CSS-variable mapping must be mirrored here by eye. */
export function vendoThemeStyle(theme: VendoTheme): string {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) {
    variables[`--vendo-color-${kebab(key)}`] = value;
  }
  variables["--vendo-font-family"] = theme.typography.fontFamily;
  if (theme.typography.headingFamily !== undefined) {
    variables["--vendo-heading-family"] = theme.typography.headingFamily;
  }
  variables["--vendo-font-size"] = theme.typography.baseSize;
  for (const [key, value] of Object.entries(theme.radius)) {
    variables[`--vendo-radius-${kebab(key)}`] = value;
  }
  variables["--vendo-density"] = theme.density;
  variables["--vendo-motion"] = theme.motion;
  return Object.entries(variables).map(([name, value]) => `${name}:${value}`).join(";");
}

/** The theme as a ready-to-inline `style` attribute (empty when unthemed). */
export function themeAttribute(theme?: VendoTheme): string {
  return theme === undefined ? "" : ` style="${escapeHtml(vendoThemeStyle(theme))}"`;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
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
