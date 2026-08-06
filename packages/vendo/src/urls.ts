import { joinUrl, publicBase } from "@vendoai/core";

/**
 * The deployment's three URLs, resolved once (spec 2026-08-06 §B1).
 *
 * `VENDO_BASE_URL` is the app's FULL public URL, path prefix included — nothing
 * may strip its path. The other two are overrides for the deployments that need
 * them: an API on another origin, and a login page that may live on another
 * domain entirely.
 */
export interface VendoUrls {
  /** VENDO_BASE_URL — the FULL public URL, path prefix included. */
  readonly publicUrl: URL;
  /** VENDO_HOST_API_URL ?? publicUrl. */
  readonly hostApiUrl: URL;
  /** VENDO_LOGIN_URL ?? joinUrl(publicUrl, "/login"). */
  readonly loginUrl: URL;
}

function configured(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * Undefined when `VENDO_BASE_URL` is unset and no request fallback was supplied
 * — the zero-config dev posture, where the wire learns its own origin from a
 * validated request instead.
 */
export function resolveVendoUrls(
  env: Record<string, string | undefined>,
  fallback?: { requestUrl?: string },
): VendoUrls | undefined {
  const base = configured(env["VENDO_BASE_URL"]) ?? configured(fallback?.requestUrl);
  if (base === undefined) return undefined;
  // A request URL carries a route path that is NOT the deployment's mount, so
  // the fallback contributes its origin only; a configured base keeps its path.
  const source = configured(env["VENDO_BASE_URL"]) === undefined
    ? new URL(base).origin
    : base;
  const { origin, path } = publicBase(source);
  const publicUrl = new URL(`${origin}${path}`);
  const hostApi = configured(env["VENDO_HOST_API_URL"]);
  const login = configured(env["VENDO_LOGIN_URL"]);
  return {
    publicUrl,
    hostApiUrl: hostApi === undefined ? publicUrl : new URL(hostApi),
    loginUrl: joinUrl(publicUrl, login ?? "/login"),
  };
}
