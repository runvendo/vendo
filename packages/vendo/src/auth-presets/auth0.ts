import { auth0Preset } from "@vendoai/actions/presets";
import { environment } from "../wire/shared.js";
import {
  actAsClaimsFromUser,
  bearerToken,
  composeHostAuthPreset,
  lazyActAs,
  lazyModule,
  loginRedirect,
  makeUserResolver,
  userFromNameEmailClaims,
  type JwtClaims,
} from "./identity.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "./shared.js";

/** Same optional-dependency strategy as authJs's @auth/core: jose is an
    optional peerDependency loaded lazily on first use (Auth0's RS256 tokens
    verify against the tenant JWKS — provider-held keys, 04 §2.1, so a JOSE
    verifier is required and jose is the SDK Auth0's own libraries build on).
    The failure is an actionable install instruction, not a bare
    module-not-found. */
const MISSING_JOSE_MESSAGE =
  "auth0() verifies Auth0 session tokens through jose, which is not installed. Install it next to your Auth0 setup: npm install jose";

const MISSING_DOMAIN_MESSAGE =
  "auth0() has no tenant domain: set AUTH0_DOMAIN (e.g. your-tenant.us.auth0.com — mirroring the Auth0 SDKs) or AUTH0_ISSUER_BASE_URL.";

interface JoseModule {
  createRemoteJWKSet(url: URL): unknown;
  jwtVerify(
    token: string,
    key: unknown,
    options: { issuer: string; audience?: string },
  ): Promise<{ payload: JwtClaims }>;
}

const loadJose = lazyModule<JoseModule>(
  () => import("jose").then((module) => module as unknown as JoseModule),
  MISSING_JOSE_MESSAGE,
);

/** The tenant issuer per Auth0's env conventions: AUTH0_DOMAIN (the v4 SDK's
    bare domain, scheme tolerated), else AUTH0_ISSUER_BASE_URL (the v3 SDK's
    full URL). Auth0 issuers always carry the trailing slash. */
function tenantIssuer(): string {
  const domain = environment("AUTH0_DOMAIN");
  if (domain !== undefined) {
    return domain.startsWith("http://") || domain.startsWith("https://")
      ? `${new URL(domain).origin}/`
      : `https://${domain}/`;
  }
  const base = environment("AUTH0_ISSUER_BASE_URL");
  if (base !== undefined) {
    try {
      return `${new URL(base).origin}/`;
    } catch {
      throw new Error(MISSING_DOMAIN_MESSAGE);
    }
  }
  throw new Error(MISSING_DOMAIN_MESSAGE);
}

/** jose's remote JWKS resolvers cache fetched keys per instance — keep one per
    tenant URL so verification never refetches per request. */
const jwksByUrl = new Map<string, unknown>();
function tenantJwks(jose: JoseModule, issuer: string): unknown {
  const url = new URL(".well-known/jwks.json", issuer).toString();
  let jwks = jwksByUrl.get(url);
  if (jwks === undefined) {
    jwks = jose.createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

/**
 * 09-vendo §2.1 — the Auth0 host-identity preset. Zero-argument in the
 * standard case: the tenant reads Auth0's own env (AUTH0_DOMAIN, or the v3
 * AUTH0_ISSUER_BASE_URL; AUTH0_AUDIENCE enforced when set), the session is
 * the Auth0-issued RS256 JWT presented as Authorization: Bearer and verified
 * against the tenant JWKS with the issuer check, and display derives from the
 * OIDC name/email claims. The optional subject→user resolver has the same
 * semantics as authJs (null = subject unknown → decline/null). The Auth0
 * SDK's encrypted `appSession` cookie is SDK-internal and stays with the
 * host's own middleware — it is not a verifiable token.
 *
 * Auth0 holds the private keys for its RS256 sessions, so the actAs half is
 * the shipped away-token producer (`auth0Preset`, 04 §2.1) — minting a
 * host-owned `VendoAway` token under VENDO_AWAY_TOKEN_SECRET; the matching
 * verify half stays host-mounted middleware (producer/verify split). The
 * `secret` option therefore overrides the AWAY-TOKEN secret (the preset's
 * system-equivalent shared secret).
 *
 * The door's sessionless redirect follows the Auth0 v4 SDK's route
 * convention: /auth/login, which natively honors returnTo.
 */
export function auth0(options: HostAuthPresetOptions = {}): HostAuthPreset {
  const { secret, user } = options;

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    const token = bearerToken(request);
    if (token === undefined) return null;
    const issuer = tenantIssuer();
    const audience = environment("AUTH0_AUDIENCE");
    const jose = await loadJose();
    try {
      const { payload } = await jose.jwtVerify(token, tenantJwks(jose, issuer), {
        issuer,
        ...(audience === undefined ? {} : { audience }),
      });
      return payload;
    } catch {
      return null; // unverifiable/expired/foreign token = no session
    }
  };

  return composeHostAuthPreset({
    sessionClaims,
    resolveUser: makeUserResolver(user, userFromNameEmailClaims),
    // Away + MCP execution: the shipped away-token producer half (04 §2.1);
    // the host mounts the matching verify middleware on its API.
    actAs: lazyActAs(() => auth0Preset({
      ...(secret === undefined ? {} : { secret }),
      ...(user === undefined ? {} : { claims: actAsClaimsFromUser(user) }),
    }).actAs),
    login: (request, returnTo) => loginRedirect(request, returnTo, "/auth/login"),
  });
}
