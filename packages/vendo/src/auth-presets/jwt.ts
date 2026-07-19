import { genericJwtPreset, verifyHs256 } from "@vendoai/actions/presets";
import {
  actAsClaimsFromUser,
  bearerToken,
  composeHostAuthPreset,
  lazyActAs,
  loginRedirect,
  makeUserResolver,
  userFromNameEmailClaims,
  type JwtClaims,
} from "./identity.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "./shared.js";

const MISSING_SECRET_OPTION_MESSAGE =
  "jwt() is not zero-argument: a host-generic JWT scheme has no vendor-owned env variable to read. Pass jwt({ secret }) — e.g. jwt({ secret: () => process.env.HOST_API_JWT_SECRET }).";

const EMPTY_SECRET_MESSAGE =
  "jwt() has no session secret: the { secret } source resolved empty.";

/**
 * 09-vendo §2.1 — the host-generic JWT host-identity preset, pairing the
 * docs' generic recipe (docs/act-as-presets.md) with a matching session
 * resolver: the host API's own HS256 bearer JWT, verified with the same
 * shared secret the actAs half (`genericJwtPreset`, 04 §2.1) signs with.
 *
 * Unlike the vendor presets this one is NOT zero-argument by nature: there is
 * no vendor-owned env variable a generic scheme could read (AUTH_SECRET
 * belongs to Auth.js, SUPABASE_JWT_SECRET to Supabase — a host's own secret
 * name is unknowable), so `secret` is required and construction fails loud
 * without it. Sessions arrive as `Authorization: Bearer <jwt>`; display
 * derives from name/email claims; the optional subject→user resolver has the
 * same semantics as authJs (null = subject unknown → decline/null).
 */
export function jwt(options: HostAuthPresetOptions = {}): HostAuthPreset {
  const { secret, user } = options;
  if (secret === undefined) {
    throw new Error(MISSING_SECRET_OPTION_MESSAGE);
  }

  const resolveSecret = async (): Promise<string> => {
    const value = typeof secret === "function" ? await secret() : secret;
    if (value === undefined || value.length === 0) {
      throw new Error(EMPTY_SECRET_MESSAGE);
    }
    return value;
  };

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    const token = bearerToken(request);
    if (token === undefined) return null;
    const resolved = await resolveSecret();
    try {
      return (await verifyHs256(token, resolved)).payload;
    } catch {
      return null; // unverifiable/expired token = no session, mirroring authJs
    }
  };

  return composeHostAuthPreset({
    sessionClaims,
    resolveUser: makeUserResolver(user, userFromNameEmailClaims),
    // Away + MCP execution: the shipped generic HS256 minting preset (04
    // §2.1), fed the same secret this preset verifies sessions with.
    actAs: lazyActAs(() => genericJwtPreset({
      secret,
      ...(user === undefined ? {} : { claims: actAsClaimsFromUser(user) }),
    })),
    login: (request, returnTo) => loginRedirect(request, returnTo),
  });
}
