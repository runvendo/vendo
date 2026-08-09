/**
 * 10-mcp §4-5 — the door's mount and the exact paths it owns.
 *
 * Split out of server.ts so the composition (compose-mcp.ts) and the wire
 * handler can share one authority without importing each other.
 */
import { BASE_PATH } from "./wire/shared.js";

/** 10-mcp §5 — the door's canonical mount under the wire's own prefix. */
export const MCP_MOUNT = `${BASE_PATH}/mcp`;

/** 10-mcp §4-5 — the paths the door owns: its own mount (plus subpaths), and the
    FOUR exact origin-root discovery documents it serves — the RFC 9728/8414
    path-inserted metadata for its fixed mount, and the SEP-2127 server card. We
    match those four EXACTLY rather than claiming the whole `/.well-known/oauth-*`
    prefixes: a boundary-free prefix would shadow a host serving its own OAuth/
    OIDC metadata at the same origin (and would even swallow
    `/.well-known/oauth-protected-resourceX`). These are NOT wire routes — the
    door mints its own principals (§3), and the OAuth /token and /register
    endpoints are form-encoded POSTs — so they bypass the wire's principal/CSRF
    machinery.

    The two METADATA documents are asked for in two spellings when the
    deployment is mounted under a path prefix. RFC 8414 §3 / RFC 9728 §3.1 derive the
    well-known URL from the FULL resource URI, so a spec client asks for
    `/.well-known/oauth-protected-resource/maple/api/vendo/mcp` where the door's
    own prefix-local metadata URL says `…/api/vendo/mcp`. Both name the SAME
    door path, and the door already answers both — it strips the configured base
    path off the suffix itself (`door.ts`). The prefix is the path of the base
    URL the door was handed (`mcp.baseUrl` ?? `VENDO_BASE_URL`, the same
    resolution as `doorBaseUrl` in createVendo — never a forwarded header, which
    is the one channel an attacker can set). With no prefix configured the set
    collapses to the same four exact paths. */
export function doorWellKnownPaths(basePath: string): ReadonlySet<string> {
  return new Set([
    `/.well-known/oauth-protected-resource${MCP_MOUNT}`,
    `/.well-known/oauth-authorization-server${MCP_MOUNT}`,
    `/.well-known/oauth-protected-resource${basePath}${MCP_MOUNT}`,
    `/.well-known/oauth-authorization-server${basePath}${MCP_MOUNT}`,
    "/.well-known/mcp/server-card.json",
    "/.well-known/mcp-server-card",
  ]);
}

/** The deployment's path prefix, normalized exactly as the door normalizes its
    own (`""` for a base URL that names only an origin). */
export function basePathOf(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return "";
  const path = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
  return path === "" ? "" : `/${path}`;
}

/** Is this origin THIS machine, and only this machine? The one question that
 *  makes a request-derived origin safe to hand a turn credential: a loopback
 *  address cannot carry the credential off the host, whoever set the Host
 *  header. `URL` throws on opaque origins (the literal string "null"), which
 *  are likewise not loopback. */
export function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  // IPv6 hostnames arrive bracketed (`[::1]`).
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isDoorPath(pathname: string, wellKnown: ReadonlySet<string>): boolean {
  if (pathname === MCP_MOUNT || pathname.startsWith(`${MCP_MOUNT}/`)) return true;
  return wellKnown.has(pathname);
}
