import { clerkPreset } from "@vendoai/actions/presets";
import { environment } from "../wire/shared.js";
import {
  actAsClaimsFromUser,
  bearerToken,
  composeHostAuthPreset,
  cookieValue,
  lazyActAs,
  lazyModule,
  loginRedirect,
  makeUserResolver,
  userFromNameEmailClaims,
  type JwtClaims,
} from "./identity.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "./shared.js";

/** Same optional-dependency strategy as authJs's @auth/core: @clerk/backend is
    an optional peerDependency loaded lazily on first use — a host wiring
    clerk() already runs Clerk, so it is present next to their auth setup. The
    failure is an actionable install instruction, not a bare module-not-found. */
const MISSING_CLERK_BACKEND_MESSAGE =
  "clerk() reads the Clerk session through @clerk/backend, which is not installed. Install it alongside your Clerk setup: npm install @clerk/backend";

const MISSING_KEY_MESSAGE =
  "clerk() has no verification key: set CLERK_SECRET_KEY (mirroring Clerk's own SDKs), optionally with CLERK_JWT_KEY (the instance's PEM public key) for networkless verification.";

/** Once per process, like auth-js's v4-cookie hint: a configuration gap
    belongs in the startup log exactly once, never in a request-path
    exception (#1338). */
let warnedMissingKey = false;

type ClerkVerifyToken = (
  token: string,
  options: { secretKey?: string; jwtKey?: string },
) => Promise<JwtClaims>;

const loadVerifyToken = lazyModule<ClerkVerifyToken>(
  () => import("@clerk/backend").then((module) => module.verifyToken as unknown as ClerkVerifyToken),
  MISSING_CLERK_BACKEND_MESSAGE,
);

/**
 * 09-vendo §2.1 — the Clerk host-identity preset. Zero-argument in the
 * standard case: session verification reads Clerk's own env (CLERK_SECRET_KEY;
 * CLERK_JWT_KEY when set enables Clerk's networkless path and is preferred),
 * the session token comes off the request per Clerk's conventions (the
 * `__session` cookie or Authorization: Bearer), and display derives from
 * name/email claims. The optional subject→user resolver has the same
 * semantics as authJs (null = subject unknown → decline/null).
 *
 * Clerk holds the private keys for its RS256 sessions, so the actAs half is
 * the shipped away-token producer (`clerkPreset`, 04 §2.1) — minting a
 * host-owned `VendoAway` token under VENDO_AWAY_TOKEN_SECRET; the matching
 * verify half stays host-mounted middleware (producer/verify split). The
 * `secret` option therefore overrides the AWAY-TOKEN secret (the preset's
 * system-equivalent shared secret), never the Clerk secret key, which is an
 * API credential and stays env-only.
 *
 * The door's sessionless redirect follows Clerk's sign-in convention:
 * NEXT_PUBLIC_CLERK_SIGN_IN_URL when set, else /sign-in, carrying both the
 * standard returnTo and Clerk's redirect_url.
 */
export function clerk(options: HostAuthPresetOptions = {}): HostAuthPreset {
  const { secret, user, memberships } = options;

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    const token = bearerToken(request) ?? cookieValue(request, "__session");
    if (token === undefined) return null;
    const jwtKey = environment("CLERK_JWT_KEY");
    const secretKey = environment("CLERK_SECRET_KEY");
    if (jwtKey === undefined && secretKey === undefined) {
      // A missing local key means "no verified session" — a state the wire
      // already handles — never an outage (#1338): Clerk hosts carry
      // __session broadly, so the old throw 501'd the ENTIRE wire in exactly
      // the state `vendo init --auth clerk` leaves you in, while a FORGED
      // token nine lines below already answered null. A missing key must not
      // answer worse than a forgery. (supabase's equivalent throw stays: its
      // cookie exists only for signed-in sessions, so the blast radius is a
      // signed-in turn, not every visitor's every request.)
      if (!warnedMissingKey) {
        warnedMissingKey = true;
        console.warn(`[vendo] ${MISSING_KEY_MESSAGE} Signed-in users resolve as anonymous until a key lands.`);
      }
      return null;
    }
    const verifyToken = await loadVerifyToken();
    try {
      return await verifyToken(token, {
        ...(jwtKey === undefined ? {} : { jwtKey }),
        ...(secretKey === undefined ? {} : { secretKey }),
      });
    } catch {
      return null; // unverifiable/expired token = no session, mirroring authJs
    }
  };

  return composeHostAuthPreset({
    name: "clerk",
    sessionClaims,
    // Build contract §9.1 (+ its companion) — handed straight through: the org
    // chart and the directory are the HOST's, and no preset interprets either.
    memberships,
    resolveUser: makeUserResolver(user, userFromNameEmailClaims),
    // Away + MCP execution: the shipped away-token producer half (04 §2.1);
    // the host mounts the matching verify middleware on its API.
    actAs: lazyActAs(() => clerkPreset({
      ...(secret === undefined ? {} : { secret }),
      ...(user === undefined ? {} : { claims: actAsClaimsFromUser(user) }),
    }).actAs),
    login: (request, returnTo) => loginRedirect(
      request,
      returnTo,
      environment("NEXT_PUBLIC_CLERK_SIGN_IN_URL") ?? "/sign-in",
      { redirect_url: returnTo },
    ),
  });
}
