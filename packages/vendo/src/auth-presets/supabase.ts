import { supabasePreset, verifyHs256 } from "@vendoai/actions/presets";
import {
  actAsClaimsFromUser,
  bearerToken,
  claimString,
  composeHostAuthPreset,
  lazyActAs,
  loginRedirect,
  makeUserResolver,
  requestCookies,
  resolvePresetSecret,
  type JwtClaims,
} from "./identity.js";
import type { HostAuthPreset, HostAuthPresetOptions, HostAuthPresetUser } from "./shared.js";

const MISSING_SECRET_MESSAGE =
  "supabase() has no JWT secret: set SUPABASE_JWT_SECRET (the project's legacy JWT signing secret — the same one supabasePreset mints with, never the anon key) or pass supabase({ secret }).";

/** Supabase's auth cookie: `sb-<project-ref>-auth-token`, optionally chunked
    across `.0`, `.1`, ... suffixes by @supabase/ssr. */
const SUPABASE_AUTH_COOKIE = /^(sb-.+-auth-token)(?:\.(\d+))?$/;

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

/** Extract the access token from a reassembled cookie value. Three shapes ship
    in the wild: @supabase/ssr's `base64-` + base64url(JSON session), and the
    legacy plain-JSON session object / `[access_token, ...]` array. */
function accessTokenFrom(value: string): string | undefined {
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
 * the standard case: the secret is SUPABASE_JWT_SECRET (the project's legacy
 * JWT signing secret, matching the shipped supabasePreset actAs half), the
 * session resolves off a plain Request per Supabase's own formats
 * (Authorization: Bearer, or the `sb-*-auth-token` cookie — @supabase/ssr's
 * `base64-`/chunked shape and the legacy JSON shapes), and display derives
 * from user_metadata.name/full_name/email. The optional subject→user resolver
 * has the same semantics as authJs (null = subject unknown → decline/null).
 *
 * No optional SDK is needed: Supabase access tokens are symmetric HS256, so
 * the SAME shared `verifyHs256` the minting half targets verifies sessions —
 * hermetic, no network, nothing to install.
 *
 * The actAs half IS the shipped `@vendoai/actions/presets` supabasePreset —
 * one minting story (04 §2.1), configured from these same options. Tokens
 * mint (and verify) under Supabase's `authenticated` audience convention.
 */
export function supabase(options: HostAuthPresetOptions = {}): HostAuthPreset {
  const { secret, user } = options;

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    const token = sessionTokenFrom(request);
    if (token === undefined) return null;
    const jwtSecret = await resolvePresetSecret(secret, "SUPABASE_JWT_SECRET", MISSING_SECRET_MESSAGE);
    try {
      return (await verifyHs256(token, jwtSecret, { audience: "authenticated" })).payload;
    } catch {
      return null; // unverifiable/expired/foreign token = no session
    }
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
