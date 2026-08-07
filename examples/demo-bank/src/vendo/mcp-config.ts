import type { CreateVendoConfig } from "@vendoai/vendo/server";
import { BASE_PATH } from "@/lib/base-path";

/**
 * WHERE THE DOOR IS ON THE PUBLIC INTERNET.
 *
 * Every URL the door advertises — issuer, endpoints, the protected-resource
 * `resource`, the RFC 8707 audience it binds tokens to — derives from the
 * public base it is handed. Next strips Maple's mount point off a request
 * before any route handler sees it, so a door handed the bare origin
 * advertises `<origin>/api/vendo/mcp` and every one of those URLs 404s.
 * Discovery is ALL a real MCP client has, so that is a dead door behind a
 * live-looking product.
 *
 * `VENDO_BASE_URL` stays the bare ORIGIN — host tool bindings concatenate it
 * with paths that already carry the mount (see src/lib/base-path.ts) — so the
 * mount goes on HERE, and only here.
 */
function doorBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const origin = env.VENDO_BASE_URL;
  return origin === undefined ? undefined : `${origin.replace(/\/+$/, "")}${BASE_PATH}`;
}

/** ENG-286: Maple's door normally serves its own OAuth surface (`mcp: true`).
 * When the operator provides the broker trust envs, the door instead trusts
 * the external authorization server (10-mcp §3.1) and answers its signed
 * login-federation handshake (§3.2):
 *
 * - `VENDO_MCP_REMOTE_AS_ISSUER`   — the tenant issuer, e.g. `https://maple.mcp.vendo.run`
 * - `VENDO_MCP_REMOTE_AS_AUDIENCE` — expected token audience (default `{issuer}/mcp`,
 *                                    the broker's tenant resource)
 * - `VENDO_MCP_REMOTE_AS_JWKS_URI` — optional JWKS override (default: discovered
 *                                    from the issuer's RFC 8414 metadata)
 * - `VENDO_MCP_FEDERATION_SECRET`  — the tenant federation secret returned once
 *                                    at broker provisioning time
 */
export function mapleMcpConfig(env: NodeJS.ProcessEnv = process.env): CreateVendoConfig["mcp"] {
  const baseUrl = doorBaseUrl(env);
  const issuer = env.VENDO_MCP_REMOTE_AS_ISSUER;
  if (!issuer) return baseUrl === undefined ? true : { baseUrl };
  const jwksUri = env.VENDO_MCP_REMOTE_AS_JWKS_URI;
  const secret = env.VENDO_MCP_FEDERATION_SECRET;
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    remoteAs: {
      issuer,
      audience: env.VENDO_MCP_REMOTE_AS_AUDIENCE ?? `${issuer.replace(/\/+$/, "")}/mcp`,
      ...(jwksUri ? { jwksUri } : {}),
    },
    ...(secret ? { federation: { secret } } : {}),
  };
}
