import { applyThemeVars, defaultVendoTheme, resolveTheme, themeCssVariables } from "@vendoai/ui/kit";

/**
 * The host's brand, applied to this document.
 *
 * ONE route reaches a served app: `?vendoTheme=<json>`. The apps runtime puts
 * the host's live tokens on the surface URL and the wire proxy forwards the
 * query string on purpose (wire/box.ts, regression-tested in
 * wire/box.served.test.ts). A malformed value is ignored — a bad theme must
 * never blank the app.
 *
 * Every token mapping is `themeCssVariables`' — the ONE flattening the chrome,
 * the jail and the Kit's own tokens already share. There is no second token set.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fromQuery = (): unknown => {
  try {
    return JSON.parse(new URLSearchParams(location.search).get("vendoTheme") ?? "null");
  } catch {
    return null;
  }
};

export function applyHostTheme(): void {
  const override = fromQuery();
  applyThemeVars(themeCssVariables(resolveTheme(defaultVendoTheme, isObject(override) ? override : undefined)));
}
