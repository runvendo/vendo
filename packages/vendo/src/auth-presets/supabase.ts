import { supabasePreset, verifyHs256 } from "@vendoai/actions/presets";
import { environment } from "../wire/shared.js";
import {
  actAsClaimsFromUser,
  bearerToken,
  claimString,
  composeHostAuthPreset,
  lazyActAs,
  lazyModule,
  loginRedirect,
  makeUserResolver,
  requestCookies,
  resolvePresetSecret,
  type JwtClaims,
} from "./identity.js";
import type { HostAuthPreset, HostAuthPresetOptions, HostAuthPresetUser } from "./shared.js";

const MISSING_VERIFIER_MESSAGE =
  "supabase() has no way to verify sessions: set SUPABASE_JWT_SECRET (the project's legacy JWT signing secret — verifies HS256 access tokens offline; the same one supabasePreset mints with, never the anon key) and/or SUPABASE_URL (the project URL — ES256 logins verify against its GoTrue JWKS at /auth/v1/.well-known/jwks.json), or pass supabase({ secret }) / supabase({ jwks }).";

/** Same optional-dependency strategy as auth0's jose: ES256 login tokens
    (Supabase's newer signing keys) verify against GoTrue's JWKS through jose,
    an optional peerDependency loaded lazily on first use. HS256-only hosts
    never hit this path and need nothing installed. */
const MISSING_JOSE_MESSAGE =
  "supabase() verifies ES256 Supabase session tokens through jose, which is not installed. Install it next to your Supabase setup: npm install jose";

interface JoseModule {
  createRemoteJWKSet(url: URL): unknown;
  jwtVerify(
    token: string,
    key: unknown,
    options: { audience: string; algorithms: string[] },
  ): Promise<{ payload: JwtClaims }>;
}

const loadJose = lazyModule<JoseModule>(
  () => import("jose").then((module) => module as unknown as JoseModule),
  MISSING_JOSE_MESSAGE,
);

/** jose's remote JWKS resolvers cache fetched keys per instance — keep one per
    URL so verification never refetches per request (auth0's pattern). */
const jwksByUrl = new Map<string, unknown>();
function remoteJwks(jose: JoseModule, url: string): unknown {
  let jwks = jwksByUrl.get(url);
  if (jwks === undefined) {
    jwks = jose.createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

export interface SupabaseHostAuthPresetOptions extends HostAuthPresetOptions {
  /** GoTrue's JWKS URL for ES256 session verification. Default: derived from
      SUPABASE_URL as `<url>/auth/v1/.well-known/jwks.json` (GoTrue's own
      well-known path); pass this to point somewhere else. The thunk form
      resolves lazily per call (the SecretSource pattern), so composition
      order never races env loading. */
  jwks?: string | URL | (() => string | URL | undefined);
}

/** Supabase's auth cookie: `sb-<project-ref>-auth-token`, optionally chunked
    across `.0`, `.1`, ... suffixes by @supabase/ssr. */
const SUPABASE_AUTH_COOKIE = /^(sb-.+-auth-token)(?:\.(\d+))?$/;

/** A compact JWS: three non-empty base64url segments. */
const RAW_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** Extract the access token from a reassembled cookie value. Four shapes ship
    in the wild: @supabase/ssr's `base64-` + base64url(JSON session), the
    legacy plain-JSON session object / `[access_token, ...]` array, and the
    raw access token itself (hand-rolled hosts, the old auth-helpers). */
function accessTokenFrom(value: string): string | undefined {
  if (RAW_JWT.test(value)) return value;
  const raw = value.startsWith("base64-") ? decodeBase64Url(value.slice("base64-".length)) : value;
  if (raw === undefined) return undefined;
  let session: unknown;
  try {
    session = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (Array.isArray(session)) {
    const token = session[0] as unknown;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }
  if (session !== null && typeof session === "object") {
    const token = (session as { access_token?: unknown }).access_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }
  return undefined;
}

/** The session token off a plain Request, per Supabase's own conventions:
    `Authorization: Bearer <access token>` (how Supabase clients call the API —
    and what the actAs half mints), else the `sb-*-auth-token` cookie with its
    chunks reassembled in order. */
function sessionTokenFrom(request: Request): string | undefined {
  const fromHeader = bearerToken(request);
  if (fromHeader !== undefined) return fromHeader;
  const chunks = new Map<string, { index: number; value: string }[]>();
  for (const [name, value] of requestCookies(request)) {
    const match = SUPABASE_AUTH_COOKIE.exec(name);
    if (match === null) continue;
    const base = match[1] as string;
    const parts = chunks.get(base) ?? [];
    parts.push({ index: match[2] === undefined ? 0 : Number(match[2]), value });
    chunks.set(base, parts);
  }
  for (const parts of chunks.values()) {
    const joined = parts.sort((left, right) => left.index - right.index).map((part) => part.value).join("");
    const token = accessTokenFrom(joined);
    if (token !== undefined) return token;
  }
  return undefined;
}

/** The token's protected-header `alg`, decoded without verification — only to
    route the token to the verifier that can possibly accept it. */
function tokenAlg(token: string): string | undefined {
  const header = decodeBase64Url(token.split(".")[0] ?? "");
  if (header === undefined) return undefined;
  try {
    const parsed = JSON.parse(header) as unknown;
    return parsed !== null && typeof parsed === "object" && typeof (parsed as { alg?: unknown }).alg === "string"
      ? (parsed as { alg: string }).alg
      : undefined;
  } catch {
    return undefined;
  }
}

/** GoTrue's JWKS URL: the `jwks` option (thunks resolved per call), else
    SUPABASE_URL's well-known path. */
function jwksUrlFrom(jwks: SupabaseHostAuthPresetOptions["jwks"]): string | undefined {
  const resolved = typeof jwks === "function" ? jwks() : jwks;
  if (resolved !== undefined) return resolved.toString();
  const projectUrl = environment("SUPABASE_URL");
  if (projectUrl === undefined) return undefined;
  try {
    return new URL("/auth/v1/.well-known/jwks.json", projectUrl).toString();
  } catch {
    return undefined;
  }
}

/** Supabase's claims→user defaults: identity lives in `user_metadata`
    (name/full_name) with the email as a top-level claim. */
function supabaseUser(claims: JwtClaims): HostAuthPresetUser {
  const metadata = claims["user_metadata"];
  const metadataClaims: JwtClaims =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as JwtClaims
      : {};
  const email = claimString(claims, "email");
  const display = claimString(metadataClaims, "name")
    ?? claimString(metadataClaims, "full_name")
    ?? claimString(claims, "name")
    ?? email;
  return {
    ...(display === undefined ? {} : { display }),
    ...(email === undefined ? {} : { email }),
  };
}

/**
 * 09-vendo §2.1 — the Supabase Auth host-identity preset. Zero-argument in
 * the standard case: it reads Supabase's own env, the session resolves off a
 * plain Request per Supabase's own formats (Authorization: Bearer, or the
 * `sb-*-auth-token` cookie — @supabase/ssr's `base64-`/chunked shape, the
 * legacy JSON shapes, and the raw access token), and display derives from
 * user_metadata.name/full_name/email. The optional subject→user resolver has
 * the same semantics as authJs (null = subject unknown → decline/null).
 *
 * Session verification is Supabase's documented HYBRID (the same one a
 * project with JWT signing keys needs), routed by the token's own `alg`:
 *
 * 1. HS256 first — the project's legacy JWT secret (SUPABASE_JWT_SECRET or
 *    `secret`), verified OFFLINE through the SAME shared `verifyHs256` the
 *    minting half targets: no network, no optional SDK, and every actAs-minted
 *    away token stays verifiable with no Supabase stack running.
 * 2. ES256 fallback — what `supabase start` ≥ v2.71 and hosted projects on
 *    the new key system sign interactive logins with, verified against
 *    GoTrue's JWKS (SUPABASE_URL → /auth/v1/.well-known/jwks.json, or the
 *    `jwks` option) through a lazily-imported jose (optional peer, cached
 *    remote key set per URL).
 *
 * Both paths enforce Supabase's `authenticated` audience, which is also what
 * keeps the project's API keys (anon/service_role — HS256 JWTs under the same
 * secret, but without that audience) from ever counting as a signed-in user.
 * Tokens neither path can verify resolve to null (no session); construction
 * with NEITHER a secret NOR a JWKS source fails loud, naming both.
 *
 * The actAs half IS the shipped `@vendoai/actions/presets` supabasePreset —
 * one minting story (04 §2.1), configured from these same options. Tokens
 * mint (and verify) under Supabase's `authenticated` audience convention.
 */
export function supabase(options: SupabaseHostAuthPresetOptions = {}): HostAuthPreset {
  const { secret, user, jwks } = options;

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    const token = sessionTokenFrom(request);
    if (token === undefined) return null;
    const jwtSecret = secret === undefined && environment("SUPABASE_JWT_SECRET") === undefined
      ? undefined
      : await resolvePresetSecret(secret, "SUPABASE_JWT_SECRET", MISSING_VERIFIER_MESSAGE);
    const jwksUrl = jwksUrlFrom(jwks);
    if (jwtSecret === undefined && jwksUrl === undefined) {
      throw new Error(MISSING_VERIFIER_MESSAGE);
    }
    const alg = tokenAlg(token);
    // HS256 first: offline, no network — and the only path a JWKS could never
    // serve. ES256 is the fallback for logins under the newer signing keys.
    if (alg === "HS256" && jwtSecret !== undefined) {
      try {
        return (await verifyHs256(token, jwtSecret, { audience: "authenticated" })).payload;
      } catch {
        return null; // unverifiable/expired/foreign token = no session
      }
    }
    if (alg === "ES256" && jwksUrl !== undefined) {
      const jose = await loadJose();
      try {
        const { payload } = await jose.jwtVerify(token, remoteJwks(jose, jwksUrl), {
          audience: "authenticated",
          algorithms: ["ES256"],
        });
        return payload;
      } catch {
        return null; // unverifiable/expired/foreign token = no session
      }
    }
    return null; // an alg (or config) neither verifier serves = no session
  };

  return composeHostAuthPreset({
    sessionClaims,
    resolveUser: makeUserResolver(user, supabaseUser),
    // Away + MCP execution: the shipped Supabase minting preset (04 §2.1),
    // fed the same secret and identity this preset resolves sessions with —
    // user identity rides the token as Supabase's own claim shape.
    actAs: lazyActAs(() => supabasePreset({
      ...(secret === undefined ? {} : { secret }),
      ...(user === undefined ? {} : {
        claims: actAsClaimsFromUser(user, (resolved) => ({
          ...(resolved.email === undefined ? {} : { email: resolved.email }),
          ...(resolved.display === undefined ? {} : { user_metadata: { name: resolved.display } }),
        })),
      }),
    })),
    login: (request, returnTo) => loginRedirect(request, returnTo),
  });
}
