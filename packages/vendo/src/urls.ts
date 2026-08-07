import { publicBase } from "@vendoai/core";

/**
 * The deployment's two URLs, resolved once (spec 2026-08-06 §B1).
 *
 * `VENDO_BASE_URL` is the app's FULL public URL, path prefix included — nothing
 * may strip its path. The other is an override for the deployments that need it:
 * an API on another origin.
 */
export interface VendoUrls {
  /** VENDO_BASE_URL — the FULL public URL, path prefix included. */
  readonly publicUrl: URL;
  /** VENDO_HOST_API_URL ?? publicUrl. */
  readonly hostApiUrl: URL;
}

function configured(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * Undefined when `VENDO_BASE_URL` is unset — the zero-config dev posture, where
 * the wire learns its own origin from a validated request instead.
 */
export function resolveVendoUrls(
  env: Record<string, string | undefined>,
): VendoUrls | undefined {
  const base = configured(env["VENDO_BASE_URL"]);
  if (base === undefined) return undefined;
  const { origin, path } = publicBase(base);
  const publicUrl = new URL(`${origin}${path}`);
  const hostApi = configured(env["VENDO_HOST_API_URL"]);
  return {
    publicUrl,
    hostApiUrl: hostApi === undefined ? publicUrl : new URL(hostApi),
  };
}
