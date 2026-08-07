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
/** Where every Vendo deployment's door is mounted — the umbrella pins it at
 *  `${BASE_PATH}/mcp` (`packages/vendo/src/wire/shared.ts`) for exactly this
 *  kind of reason: it is the one part of the caller's url this helper can tell
 *  apart from the deployment's path prefix. A door mounted anywhere else is
 *  served only at the root-inserted spelling below. */
const DOOR_MOUNT = "/api/vendo/mcp";
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
  // The caller's OWN url answers to the same rule as the endpoint discovery
  // names, and it answers first — before a single request goes out. Discovery
  // carries no credential, but over cleartext http it is forgeable in flight:
  // whoever is on the path rewrites `authorization_servers` to an https
  // endpoint of their own, that endpoint passes the check below, and the
  // service key is posted to them.
  if (!isSecureUrl(input.url)) {
    throw new Error(
      `${input.url} is not an HTTPS URL; over plain http the discovery metadata that names where the `
      + "service key is posted can be rewritten by anyone on the path, and the key itself would travel "
      + "in the clear. Use https (loopback http is the only exception).",
    );
  }
  const transport = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The budget and the refusal to follow redirects are properties of every call
  // the helper makes, so they are bound once here rather than threaded through
  // discovery. Discovery carries no credential, but it names the URL the key is
  // posted to, so a hop nobody saw decides that too.
  const call: typeof fetch = (url, init) =>
    transport(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
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
  // 307 and 308 keep the body, so a redirect off the validated endpoint carries
  // the key to a URL that no HTTPS check ever saw — including plain http or
  // another origin. The hop is the answer, not a step on the way to one.
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Service-key exchange at ${tokenEndpoint} was redirected (HTTP ${response.status} to `
      + `${response.headers.get("location") ?? "an unnamed location"}); a service key is not `
      + "followed onto a URL discovery never named",
    );
  }
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
  const metadata = await protectedResource<{ resource: string; authorization_servers?: string[] }>(call, mcpUrl);
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
    return { tokenEndpoint: secureEndpoint(`${issuerBase}/token`), resource: metadata.resource };
  }
  const server = await getJson<{ token_endpoint?: string }>(call, wellKnown(AS_PREFIX, issuerBase));
  if (server.token_endpoint === undefined) {
    throw new Error(`The authorization server ${issuer} publishes no token_endpoint`);
  }
  return { tokenEndpoint: secureEndpoint(server.token_endpoint) };
}

/** ONE rule for every URL this exchange touches — the caller's own MCP url, and
 *  the token endpoint the key is posted to whether a third party published it or
 *  the deployment named itself: RFC 8414 §2 requires https, and anything else
 *  puts a long-lived credential on the wire in cleartext for whoever is
 *  listening — or lets them rewrite the metadata that names where it goes.
 *  Loopback http is the same exception the door already makes for redirect URIs
 *  (`validRedirectUri` in `oauth/server.js`). */
function isSecureUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
}

function secureEndpoint(endpoint: string): string {
  if (isSecureUrl(endpoint)) return endpoint;
  throw new Error(`${endpoint} is a token_endpoint that is not an HTTPS URL; a service key is not sent in cleartext`);
}

/** The door publishes its protected-resource metadata at TWO URLs, and this asks
 *  for them in that order.
 *
 *  ROOT-INSERTED first (`wellKnown`): it is what RFC 9728 §3.1 says a client
 *  derives from the resource URI, and it is the spelling that answers whenever
 *  the deployment owns its origin root — including one mounted under a path
 *  prefix by a proxy that strips it.
 *
 *  A deployment mounted under a prefix by its own FRAMEWORK routes nothing
 *  outside that prefix (Next `basePath` answers its own 404 before Vendo is ever
 *  reached), so only there does a 404 fall through to the door's PREFIX-LOCAL
 *  spelling — the same document, at the URL the door itself advertises in its
 *  401 challenge and server card (`protectedResourceMetadataUrl` in `door.js`).
 *  Never the other way round: the prefix-local URL is a fallback, not a
 *  preference.
 *
 *  Both URLs are built from the caller's own url — nothing a response said — so
 *  the fallback inherits the https rule that url already passed, and adds no
 *  trust surface. Only a 404 falls through: any other failure is the
 *  deployment's answer about the URL a client would really use. */
async function protectedResource<T>(call: typeof fetch, mcpUrl: string): Promise<T> {
  const rootInserted = wellKnown(PRM_PREFIX, mcpUrl);
  const response = await call(rootInserted);
  if (response.ok) return await response.json() as T;
  const prefixLocal = prefixLocalMetadataUrl(mcpUrl);
  if (response.status !== 404 || prefixLocal === undefined) {
    throw new Error(`Discovery failed: GET ${rootInserted} answered ${response.status}`);
  }
  const local = await call(prefixLocal);
  if (local.ok) return await local.json() as T;
  throw new Error(
    `Discovery failed: GET ${rootInserted} answered 404, and GET ${prefixLocal} answered ${local.status}`,
  );
}

/** The door's own metadata URL for a deployment mounted under a path prefix:
 *  the prefix, then the well-known segment, then the mount — `base + PRM_PREFIX
 *  + mount`, exactly as `protectedResourceMetadataUrl` builds it. The prefix is
 *  whatever the caller's url carries in FRONT of the door's mount. `undefined`
 *  when there is nothing in front of it (the root-inserted URL is already the
 *  only spelling) or when the url does not end at a door mount this helper can
 *  recognize — then there is no second URL it could honestly name. */
function prefixLocalMetadataUrl(mcpUrl: string): string | undefined {
  const url = new URL(mcpUrl);
  if (!url.pathname.endsWith(DOOR_MOUNT)) return undefined;
  const prefix = url.pathname.slice(0, -DOOR_MOUNT.length);
  return prefix === "" ? undefined : `${url.origin}${prefix}${PRM_PREFIX}${DOOR_MOUNT}`;
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
