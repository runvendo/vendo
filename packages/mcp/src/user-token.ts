/**
 * The caller's side of the door's service-key exchange (`oauth/service-keys.ts`):
 * a host's own backend presents its key plus one of its user ids and gets back
 * the short-lived, user-bound access token it then talks MCP with.
 *
 * Discovery, not configuration: the MCP endpoint is the only URL a backend
 * knows, so the token endpoint is read off the door's own RFC 9728 metadata —
 * which is also what follows a deployment that trusts an external
 * authorization server (the hosted broker) to THAT server's token endpoint,
 * without the caller having to know there is one.
 *
 * No retries and no cache: one call mints one token, and the caller owns
 * whatever policy it wants around that.
 */

import {
  SERVICE_CLIENT_ID,
  SERVICE_SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "./oauth/service-keys.js";

const PRM_PREFIX = "/.well-known/oauth-protected-resource";
const AS_PREFIX = "/.well-known/oauth-authorization-server";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface VendoUserTokenInput {
  /** The deployment's MCP endpoint, e.g. `https://app.example.com/api/vendo/mcp`. */
  url: string;
  /** A `vsk_…` service key from `vendo service-key new`, listed in the
   *  deployment's `mcp.serviceAuth.keys`. */
  key: string;
  /** One of the host's OWN user ids — the same spelling `principal()` answers
   *  to. The token is bound to it. */
  user: string;
  /** Injectable transport (a composed handler in tests, a proxy in production). */
  fetch?: typeof fetch;
  /** Per-request budget for discovery and the exchange. Default 10s. */
  timeoutMs?: number;
}

export interface VendoUserToken {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  expiresAt: Date;
  scope: string;
}

export async function vendoUserToken(input: VendoUserTokenInput): Promise<VendoUserToken> {
  const call = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenEndpoint = await discoverTokenEndpoint(call, timeoutMs, input.url);
  const response = await call(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      client_id: SERVICE_CLIENT_ID,
      client_secret: input.key,
      subject_token: input.user,
      subject_token_type: SERVICE_SUBJECT_TOKEN_TYPE,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(await exchangeFailure(response, tokenEndpoint));
  const body = await response.json() as { access_token: string; expires_in: number; scope: string };
  return {
    accessToken: body.access_token,
    tokenType: "Bearer",
    expiresIn: body.expires_in,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    scope: body.scope,
  };
}

/**
 * A door names ITSELF as its authorization server, so its token endpoint is
 * `{resource}/token`. A door that trusts an external one names that issuer
 * instead, and the issuer publishes where its token endpoint really is.
 */
async function discoverTokenEndpoint(
  call: typeof fetch,
  timeoutMs: number,
  mcpUrl: string,
): Promise<string> {
  const url = new URL(mcpUrl);
  const metadata = await getJson<{ resource: string; authorization_servers?: string[] }>(
    call,
    timeoutMs,
    `${url.origin}${PRM_PREFIX}${url.pathname === "/" ? "" : url.pathname}`,
  );
  const issuer = metadata.authorization_servers?.[0];
  if (issuer === undefined) {
    throw new Error(`${mcpUrl} names no authorization server, so there is no token endpoint to exchange at`);
  }
  if (trimSlash(issuer) === trimSlash(metadata.resource)) return `${trimSlash(issuer)}/token`;
  const server = await getJson<{ token_endpoint?: string }>(
    call,
    timeoutMs,
    `${trimSlash(issuer)}${AS_PREFIX}`,
  );
  if (server.token_endpoint === undefined) {
    throw new Error(`The authorization server ${issuer} publishes no token_endpoint`);
  }
  return server.token_endpoint;
}

async function getJson<T>(call: typeof fetch, timeoutMs: number, url: string): Promise<T> {
  const response = await call(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Discovery failed: GET ${url} answered ${response.status}`);
  return await response.json() as T;
}

/** The door's refusals are OAuth errors, and they are the whole diagnosis —
 *  pass them through rather than reporting an HTTP status nobody can act on. */
async function exchangeFailure(response: Response, tokenEndpoint: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string; error_description?: string } | null;
  const oauth = body?.error === undefined
    ? `HTTP ${response.status}`
    : `${body.error}${body.error_description === undefined ? "" : `: ${body.error_description}`}`;
  return `Service-key exchange at ${tokenEndpoint} failed — ${oauth}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
