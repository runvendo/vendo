import { authJsPreset, type SecretSource } from "@vendoai/actions/presets";
import type { Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";
import { environment } from "../wire/shared.js";
import type { HostAuthPreset, HostAuthPresetOptions, HostAuthPresetUser } from "./shared.js";

type JwtClaims = Record<string, unknown>;

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
let getTokenPromise: Promise<AuthJsGetToken> | undefined;
function loadGetToken(): Promise<AuthJsGetToken> {
  getTokenPromise ??= import("@auth/core/jwt").then(
    (module) => module.getToken as unknown as AuthJsGetToken,
    (cause) => {
      getTokenPromise = undefined; // let a later call retry after an install
      throw new Error(
        "authJs() reads the Auth.js session through @auth/core, which is not installed. Install it alongside your Auth.js setup: npm install @auth/core",
        { cause: cause as Error },
      );
    },
  );
  return getTokenPromise;
}

/** Secure-cookie posture, generalized from demo-bank's isSecureDeployment: the
    deployment is secure exactly when the operator-set VENDO_BASE_URL parses as
    an https URL — TLS terminates at a trusted proxy and Auth.js is using its
    `__Secure-` cookie names. Same trusted-origin channel the umbrella already
    uses for anon-cookie hardening and door metadata; never derived from
    forwarded headers. */
function isSecureDeployment(): boolean {
  const base = environment("VENDO_BASE_URL");
  if (base === undefined) return false;
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolved lazily per call (mirroring demo-bank's `() => authSecret()`), so
    composition order never races env loading. Absence fails loud with the fix
    in hand — Auth.js itself throws MissingSecret in the same spot. */
async function resolveAuthSecret(source: SecretSource | undefined): Promise<string> {
  const value = source === undefined
    ? environment("AUTH_SECRET")
    : typeof source === "function"
      ? await source()
      : source;
  if (value === undefined || value.length === 0) {
    throw new Error(
      "authJs() has no session secret: set AUTH_SECRET (mirroring Auth.js itself) or pass authJs({ secret }).",
    );
  }
  return value;
}

/** The operator-set public origin (VENDO_BASE_URL) or, failing that, the
    request's own origin — mirrors how the door derives its URLs. */
function publicOrigin(request: Request): URL {
  return new URL(environment("VENDO_BASE_URL") ?? request.url);
}

function claimString(claims: JwtClaims, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
  const { secret, user } = options;

  const sessionClaims = async (request: Request): Promise<JwtClaims | null> => {
    const getToken = await loadGetToken();
    return getToken({
      req: request,
      secret: await resolveAuthSecret(secret),
      secureCookie: isSecureDeployment(),
    });
  };

  /** One identity lookup for all three seams. `claims` is the decoded token
      where one exists, {} where none does (actAs minting, door subject lookup). */
  const resolveUser = async (subject: string, claims: JwtClaims): Promise<HostAuthPresetUser | null> => {
    if (user !== undefined) return user(subject, claims);
    const email = claimString(claims, "email");
    const display = claimString(claims, "name") ?? email;
    return {
      ...(display === undefined ? {} : { display }),
      ...(email === undefined ? {} : { email }),
    };
  };

  const principalFor = async (subject: string, claims: JwtClaims): Promise<Principal | null> => {
    const resolved = await resolveUser(subject, claims);
    if (resolved === null) return null;
    return {
      kind: "user",
      subject,
      ...(resolved.display === undefined ? {} : { display: resolved.display }),
    };
  };

  const principal = async (request: Request): Promise<Principal | null> => {
    const claims = await sessionClaims(request);
    if (claims === null) return null;
    const subject = claimString(claims, "sub");
    return subject === undefined ? null : principalFor(subject, claims);
  };

  // Away + MCP execution: the shipped Auth.js minting preset, fed the same
  // secret/posture/identity this preset resolves sessions with. Without a
  // subject→user resolver nothing can decline, and the mint carries only `sub`
  // (there are no claims to look up) — which is what lets the doctor's
  // synthetic actAs probe round-trip. NOTE: the posture is captured when
  // authJs() is called (composition time), same as demo-bank's module-level
  // actAsMapleUser.
  const actAs = authJsPreset({
    ...(secret === undefined ? {} : { secret }),
    secureCookie: isSecureDeployment(),
    ...(user === undefined ? {} : {
      claims: async (grantPrincipal: Principal) => {
        const resolved = await user(grantPrincipal.subject, {});
        if (resolved === null) return null;
        return {
          ...(resolved.display === undefined ? {} : { name: resolved.display }),
          ...(resolved.email === undefined ? {} : { email: resolved.email }),
        };
      },
    }),
  });

  // The door's identity seam (10-mcp §3): host session lookup + subject
  // resolution; the door owns consent, CSRF, replay, and redirects.
  const oauth: HostOAuthAdapter = {
    async session(request, { returnTo }) {
      const claims = await sessionClaims(request);
      const subject = claims === null ? undefined : claimString(claims, "sub");
      if (subject !== undefined && claims !== null && await resolveUser(subject, claims) !== null) {
        return { subject };
      }
      // Mirror demo-bank's returnTo handling: send the visitor to the host
      // login on the public origin, carrying the exact authorization URL the
      // login must return to.
      const login = new URL("/login", publicOrigin(request));
      login.searchParams.set("returnTo", returnTo);
      return Response.redirect(login);
    },
    async principal(subject) {
      return principalFor(subject, {});
    },
  };

  return { principal, actAs, oauth };
}
