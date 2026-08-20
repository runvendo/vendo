// authJsPreset ships on its own subpath, not the shared "@vendoai/actions/presets"
// barrel: it is the only preset there with a top-level optional-peer dynamic
// import (@auth/core/jwt), and bundlers resolve every `export ... from` target
// in a barrel file regardless of which export a consumer uses (corpus-triage
// Task 9 — mirrors the same split done for this file's own vendo-side barrel).
import { authJsPreset } from "@vendoai/actions/presets/auth-js";
import type { ActAs } from "@vendoai/core";
import { environment } from "../wire/shared.js";
import {
  actAsClaimsFromUser,
  composeHostAuthPreset,
  cookieValue,
  lazyActAs,
  lazyModule,
  loginRedirect,
  makeUserResolver,
  resolvePresetSecret,
  userFromNameEmailClaims,
  type JwtClaims,
} from "./identity.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "./shared.js";

type AuthJsGetToken = (params: {
  req: Request | { headers: Headers | Record<string, string> };
  secret: string;
  secureCookie?: boolean;
}) => Promise<JwtClaims | null>;

/** Same optional-dependency strategy as the actions preset's own encoder
    (packages/actions presets/auth-js.ts): `@auth/core` is an optional
    peerDependency loaded lazily on first use — a host wiring authJs() already
    runs Auth.js, so it is present next to their auth setup. The failure is an
    actionable install instruction, not a bare module-not-found. */
const MISSING_AUTH_CORE_MESSAGE =
  "authJs() reads the Auth.js session through @auth/core, which is not installed. Install it alongside your Auth.js setup: npm install @auth/core";

const MISSING_SECRET_MESSAGE =
  "authJs() has no session secret: set AUTH_SECRET (mirroring Auth.js itself; next-auth v4's NEXTAUTH_SECRET also works) or pass authJs({ secret }).";

/** Auth.js v5's two session cookie spellings — the only names getToken reads. */
const AUTH_JS_SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"] as const;

/** next-auth v4's spellings: vendo cannot read these (v4 uses its own cookie
    names AND its own JWE derivation), but seeing one means the host is a v4
    install whose signed-in users will resolve as anonymous — worth naming
    exactly once instead of failing silently forever. */
const NEXT_AUTH_V4_SESSION_COOKIES = ["next-auth.session-token", "__Secure-next-auth.session-token"] as const;

let warnedV4Cookie = false;

/** Node's dynamic-import failure for a package that simply isn't installed. */
function isAuthCoreNotFound(error: unknown): boolean {
  return error instanceof Error
    && (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    && error.message.includes("@auth/core");
}

const loadGetToken = lazyModule<AuthJsGetToken>(
  () => import("@auth/core/jwt").then((module) => module.getToken as unknown as AuthJsGetToken),
  MISSING_AUTH_CORE_MESSAGE,
);

/** Secure-cookie posture, generalized from demo-bank's isSecureDeployment: the
    deployment is secure exactly when the operator-set VENDO_BASE_URL parses as
    an https URL — TLS terminates at a trusted proxy and Auth.js is using its
    `__Secure-` cookie names. Same trusted-origin channel the umbrella already
    uses for door metadata; never derived from forwarded headers. */
function isSecureDeployment(): boolean {
  const base = environment("VENDO_BASE_URL");
  if (base === undefined) return false;
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 09-vendo §2.1 — the Auth.js host-identity preset. Zero-argument in the
 * standard case: the secret is AUTH_SECRET, the secure-cookie posture follows
 * VENDO_BASE_URL (https → `__Secure-` names), and the principal's display
 * derives from the session token's name/email claims. An optional subject→user
 * resolver overrides claims-derived identity for BOTH the principal display and
 * the actAs session claims; its null means "subject unknown to host" (the
 * session is treated as absent, actAs declines, the door's lookup returns null).
 *
 * The actAs half IS the shipped `@vendoai/actions/presets` authJsPreset — one
 * minting story (04 §2.1), configured from these same options.
 */
export function authJs(options: HostAuthPresetOptions = {}): HostAuthPreset {
  const { secret, user, memberships } = options;

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    // No Auth.js session cookie → no session, before any module/secret work: a
    // misconfigured preset must not take down anonymous traffic (#872). A
    // v4-named cookie gets one loud hint — v4 sessions are structurally
    // unreadable here (different cookie names AND JWE derivation).
    if (!AUTH_JS_SESSION_COOKIES.some((name) => cookieValue(request, name) !== undefined)) {
      if (!warnedV4Cookie && NEXT_AUTH_V4_SESSION_COOKIES.some((name) => cookieValue(request, name) !== undefined)) {
        warnedV4Cookie = true;
        console.warn(
          "[vendo] a next-auth v4 session cookie (next-auth.session-token) was seen, but authJs() speaks Auth.js v5 — "
          + "v4 sessions resolve as anonymous. Upgrade next-auth to v5, or see docs/act-as-presets.md for the v4 posture.",
        );
      }
      return null;
    }
    const getToken = await loadGetToken();
    return getToken({
      req: request,
      // AUTH_SECRET then next-auth v4's NEXTAUTH_SECRET — Auth.js's own
      // legacy-name order; an explicit source stays authoritative.
      secret: await resolvePresetSecret(
        secret ?? (() => environment("AUTH_SECRET") ?? environment("NEXTAUTH_SECRET")),
        undefined,
        MISSING_SECRET_MESSAGE,
      ),
      // The deployment's posture AND this request's own protocol. A browser
      // never sends a `__Secure-` cookie over http, so reading for one on an
      // http request can only ever miss: an app served over http that declares
      // an https VENDO_BASE_URL (the posture Cloud forces) had vendo looking
      // for `__Secure-authjs.session-token` while the wire carried
      // `authjs.session-token`, and getToken returned null before it attempted
      // decryption — the name is the JWE salt too, so it could not have
      // decrypted the other one either. Narrowing rather than widening keeps
      // the `__Secure-` prefix's browser-enforced guarantee on real https
      // traffic, where honouring a plain-named cookie would let anything that
      // can write over http plant a session the https origin then trusts.
      secureCookie: isSecureDeployment() && new URL(request.url).protocol === "https:",
    });
  };

  // Away + MCP execution: the shipped Auth.js minting preset, fed the same
  // secret/posture/identity this preset resolves sessions with. Built lazily
  // on FIRST MINT and cached (its TokenCache survives across calls): the
  // secure-cookie posture then resolves at use time like the secret does,
  // never racing env loading at composition. A missing @auth/core fails with
  // the same actionable install error as the other two halves, not the
  // encoder's bare module-not-found.
  const mint = lazyActAs(() => authJsPreset({
    ...(secret === undefined ? {} : { secret }),
    secureCookie: isSecureDeployment(),
    ...(user === undefined ? {} : { claims: actAsClaimsFromUser(user) }),
  }));
  const actAs: ActAs = async (principal, grant) => {
    try {
      return await mint(principal, grant);
    } catch (error) {
      if (isAuthCoreNotFound(error)) {
        throw new Error(MISSING_AUTH_CORE_MESSAGE, { cause: error as Error });
      }
      throw error;
    }
  };

  return composeHostAuthPreset({
    name: "authJs",
    sessionClaims,
    // Build contract §9.1 (+ its companion) — handed straight through: the org
    // chart and the directory are the HOST's, and no preset interprets either.
    memberships,
    resolveUser: makeUserResolver(user, userFromNameEmailClaims),
    actAs,
    login: (request, returnTo) => loginRedirect(request, returnTo),
  });
}
