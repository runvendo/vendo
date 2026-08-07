/**
 * The caller's side of the door's service-key exchange (`oauth/service-keys.ts`):
 * a host's own backend presents its key plus one of its user ids and gets back
 * the short-lived, user-bound access token it then talks MCP with.
 *
 * Discovery, not configuration: the MCP endpoint is the only URL a backend
 * knows, so the token endpoint is read off the door's own RFC 9728 metadata —
 * which is also what follows a deployment that trusts an external
 * authorization server (the hosted broker) to THAT server's token endpoint.
 *
 * No retries and no cache: one call mints one token.
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
  const transport = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The budget is a property of every call the helper makes, so it is bound
  // once here rather than threaded through discovery.
  const call: typeof fetch = (url, init) => transport(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const { tokenEndpoint, resource } = await discoverTokenEndpoint(call, input.url);
  const response = await call(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      client_id: SERVICE_CLIENT_ID,
      client_secret: input.key,
      subject_token: input.user,
      subject_token_type: SERVICE_SUBJECT_TOKEN_TYPE,
      ...(resource === undefined ? {} : { resource }),
    }),
  });
  if (!response.ok) throw new Error(await exchangeFailure(response, tokenEndpoint));
  const body = await response.json().catch(() => null) as
    { access_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  // A 200 is not a token. Every field of `VendoUserToken` is declared present,
  // and a response missing one turns into `expiresAt: Invalid Date` or an
  // `undefined` scope that only fails somewhere else, much later. The body is
  // never echoed: a partial one still carries an access token.
  if (typeof body?.access_token !== "string" || typeof body.scope !== "string"
    || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new Error(
      `Service-key exchange at ${tokenEndpoint} answered 200 without a usable token`
      + " — access_token, expires_in, and scope are all required. The response is not echoed here.",
    );
  }
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
  mcpUrl: string,
): Promise<{ tokenEndpoint: string; resource?: string }> {
  const metadata = await getJson<{ resource: string; authorization_servers?: string[] }>(
    call,
    wellKnown(PRM_PREFIX, mcpUrl),
  );
  const issuer = metadata.authorization_servers?.[0];
  if (issuer === undefined) {
    throw new Error(`${mcpUrl} names no authorization server, so there is no token endpoint to exchange at`);
  }
  const issuerBase = trimSlash(issuer);
  // RFC 8707 `resource` names the audience the token is FOR, in the door's own
  // spelling of itself rather than the string the caller typed. Naming it turns
  // a token endpoint reached under some other mount into `invalid_target`
  // instead of a token bound to the wrong resource. An EXTERNAL authorization
  // server picks the audience by its own policy — asking it for this
  // deployment's resource is a refusal, not a pin — so only the door's own
  // token endpoint is asked.
  if (issuerBase === trimSlash(metadata.resource)) {
    return { tokenEndpoint: `${issuerBase}/token`, resource: metadata.resource };
  }
  const server = await getJson<{ token_endpoint?: string }>(call, wellKnown(AS_PREFIX, issuerBase));
  if (server.token_endpoint === undefined) {
    throw new Error(`The authorization server ${issuer} publishes no token_endpoint`);
  }
  // The only URL in this flow that a THIRD party chooses, and the key is posted
  // to it. RFC 8414 §2 requires https; anything else puts a long-lived
  // credential on the wire in cleartext for whoever is listening. Loopback http
  // is the same exception the door already makes for redirect URIs
  // (`validRedirectUri` in `oauth/server.js`).
  if (!secureEndpoint(server.token_endpoint)) {
    throw new Error(
      `The authorization server ${issuer} publishes a token_endpoint that is not an HTTPS URL `
      + `(${server.token_endpoint}); a service key is not sent in cleartext`,
    );
  }
  return { tokenEndpoint: server.token_endpoint };
}

function secureEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** RFC 8414 §3 / RFC 9728 §3.1: the well-known segment goes BETWEEN the origin
 *  and the path, so an issuer or resource mounted under a path is still found.
 *  Suffixing it names a path on the server instead of a document. */
function wellKnown(prefix: string, base: string): string {
  const url = new URL(base);
  return `${url.origin}${prefix}${url.pathname === "/" ? "" : url.pathname}`;
}

async function getJson<T>(call: typeof fetch, url: string): Promise<T> {
  const response = await call(url);
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
