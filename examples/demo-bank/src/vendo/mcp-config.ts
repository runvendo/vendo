import type { CreateVendoConfig } from "@vendoai/vendo/server";

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
  const issuer = env.VENDO_MCP_REMOTE_AS_ISSUER;
  if (!issuer) return true;
  const jwksUri = env.VENDO_MCP_REMOTE_AS_JWKS_URI;
  const secret = env.VENDO_MCP_FEDERATION_SECRET;
  return {
    remoteAs: {
      issuer,
      audience: env.VENDO_MCP_REMOTE_AS_AUDIENCE ?? `${issuer.replace(/\/+$/, "")}/mcp`,
      ...(jwksUri ? { jwksUri } : {}),
    },
    ...(secret ? { federation: { secret } } : {}),
  };
}
