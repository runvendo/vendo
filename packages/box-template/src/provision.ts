import { applyThemeVars, defaultVendoTheme, resolveTheme, themeCssVariables } from "@vendoai/ui/kit";
import type { VendoAppProviderProps } from "@vendoai/ui/kit";

/**
 * The page half of the provision contract (the disk half is ../provision.mjs).
 *
 * Two theme routes reach a served app, and BOTH stay open:
 *
 *  1. `?vendoTheme=<json>` — the shipped route. The apps runtime puts the host's
 *     live tokens on the surface URL and the wire proxy forwards the query string
 *     on purpose (wire/box.ts, regression-tested in wire/box.served.test.ts).
 *  2. `.vendo/host/theme.json` — the provisioned brand baseline, injected as data
 *     when the box was created and spliced into this page by whichever server
 *     served it.
 *
 * The query param WINS: it is the host's theme at the moment the surface opened,
 * while the file is the baseline captured at provision. A malformed value on
 * either route is ignored — a bad theme must never blank the app.
 */

interface InjectedRuntime {
  appId?: string;
  theme?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `<script id="vendo-runtime">` block the server spliced in. Absent, empty
 *  or unparseable (the dev server without provision data, a box provisioned
 *  bare) all mean the same thing: no injected data, carry on with defaults. */
const injected = (): InjectedRuntime => {
  const raw = document.getElementById("vendo-runtime")?.textContent ?? "";
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed as InjectedRuntime : {};
  } catch {
    return {};
  }
};

const fromQuery = (): unknown => {
  try {
    return JSON.parse(new URLSearchParams(location.search).get("vendoTheme") ?? "null");
  } catch {
    return null;
  }
};

/**
 * Apply the host's brand to this document and return the provider props the
 * served URL cannot supply.
 *
 * Every token mapping is `themeCssVariables`' — the ONE flattening the chrome,
 * the jail and the Kit's own tokens already share. There is no second token set.
 *
 * The address is deliberately almost always EMPTY. `VendoAppProvider` derives
 * `{baseUrl, appId}` from its own served path (`/apps/<id>/serve/...`), which is
 * the shipped shape for a shared app and survives a host that mounts the wire
 * under a base path. Only the personal branch is served from a provider URL
 * whose path carries neither half — and that is the one case the box is told its
 * own id at provision. So this returns an override, never a default.
 */
export function applyProvisionedBrand(): VendoAppProviderProps {
  const runtime = injected();
  const override = fromQuery() ?? runtime.theme;
  applyThemeVars(themeCssVariables(resolveTheme(defaultVendoTheme, isObject(override) ? override : undefined)));
  return runtime.appId === undefined ? {} : { appId: runtime.appId };
}
