import type { SecretSource } from "@vendoai/actions/presets";
import type { ActAs, PermissionGrant, Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";
import { environment } from "../wire/shared.js";
import type { HostAuthPreset, HostAuthPresetUser, HostAuthPresetUserResolver } from "./shared.js";

/** Internal machinery shared by the named host-identity presets (09 §2.1).
    authJs (the template preset) predates this file and keeps its own copy of
    the same moves; the public surface stays the preset functions themselves. */

export type JwtClaims = Record<string, unknown>;

export function claimString(claims: JwtClaims, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The presets' default claims→user mapping: display from the `name` claim,
    falling back to `email`; email from `email` (feeds actAs claims only). */
export function userFromNameEmailClaims(claims: JwtClaims): HostAuthPresetUser {
  const email = claimString(claims, "email");
  const display = claimString(claims, "name") ?? email;
  return {
    ...(display === undefined ? {} : { display }),
    ...(email === undefined ? {} : { email }),
  };
}

/** One identity lookup for all three seams: the host's subject→user resolver
    when configured (null = subject unknown → decline), else the system's
    claims-derived defaults. `claims` is {} where no token exists (actAs
    minting, the door's subject lookup). */
export function makeUserResolver(
  user: HostAuthPresetUserResolver | undefined,
  defaults: (claims: JwtClaims) => HostAuthPresetUser,
): (subject: string, claims: JwtClaims) => Promise<HostAuthPresetUser | null> {
  return async (subject, claims) => (user !== undefined ? user(subject, claims) : defaults(claims));
}

/** Bridge the subject→user resolver into an actions-preset claims resolver:
    null still declines the mint; display/email become session claims. */
export function actAsClaimsFromUser(
  user: HostAuthPresetUserResolver,
  toClaims: (resolved: HostAuthPresetUser) => JwtClaims = (resolved) => ({
    ...(resolved.display === undefined ? {} : { name: resolved.display }),
    ...(resolved.email === undefined ? {} : { email: resolved.email }),
  }),
): (principal: Principal, grant: PermissionGrant) => Promise<JwtClaims | null> {
  return async (principal) => {
    const resolved = await user(principal.subject, {});
    return resolved === null ? null : toClaims(resolved);
  };
}

/** Per-call secret resolution (authJs's resolveAuthSecret pattern): default to
    the system's own env variable, resolved lazily so composition order never
    races env loading; absence fails loud with the fix in hand. */
export async function resolvePresetSecret(
  source: SecretSource | undefined,
  environmentName: string | undefined,
  missingMessage: string,
): Promise<string> {
  const value = source === undefined
    ? (environmentName === undefined ? undefined : environment(environmentName))
    : typeof source === "function"
      ? await source()
      : source;
  if (value === undefined || value.length === 0) {
    throw new Error(missingMessage);
  }
  return value;
}

/** The operator-set public origin (VENDO_BASE_URL) or, failing that, the
    request's own origin — mirrors authJs and how the door derives its URLs. */
export function publicOrigin(request: Request): URL {
  return new URL(environment("VENDO_BASE_URL") ?? request.url);
}

export function requestCookies(request: Request): [name: string, value: string][] {
  const header = request.headers.get("cookie");
  if (header === null) return [];
  const entries: [string, string][] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name.length === 0) continue;
    let value = part.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not URI-encoded — keep the raw value.
    }
    entries.push([name, value]);
  }
  return entries;
}

export function cookieValue(request: Request, name: string): string | undefined {
  return requestCookies(request).find(([cookieName]) => cookieName === name)?.[1];
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Optional-SDK loader mirroring authJs's loadGetToken: cached on success,
    reset on failure so a later call retries after an install, and an import
    failure surfaces the actionable install instruction, never a bare
    module-not-found. */
export function lazyModule<T>(load: () => Promise<T>, missingMessage: string): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= load().then(
      (loaded) => loaded,
      (cause) => {
        cached = undefined; // let a later call retry after an install
        throw new Error(missingMessage, { cause: cause as Error });
      },
    );
    return cached;
  };
}

/** ActAs built lazily on FIRST MINT and cached (authJs's pattern, its
    TokenCache surviving across calls): env-dependent secrets and posture
    resolve at use time, never racing env loading at composition. */
export function lazyActAs(build: () => ActAs): ActAs {
  let mint: ActAs | undefined;
  return async (principal, grant) => (mint ??= build())(principal, grant);
}

/** /login?returnTo= on the deployment's public origin (authJs parity). Systems
    whose own convention demands it pass a different path (Clerk's /sign-in,
    Auth0's /auth/login) or extra params — never a new preset option. */
export function loginRedirect(
  request: Request,
  returnTo: string,
  path = "/login",
  extraParams: Record<string, string> = {},
): Response {
  const login = new URL(path, publicOrigin(request));
  login.searchParams.set("returnTo", returnTo);
  for (const [name, value] of Object.entries(extraParams)) {
    login.searchParams.set(name, value);
  }
  return Response.redirect(login);
}

export interface ComposeHostAuthPresetOptions {
  /** Decode + verify the request's host session; null = no/invalid session. */
  sessionClaims(request: Request): Promise<JwtClaims | null>;
  /** One identity lookup for all three seams ({} claims where none exist). */
  resolveUser(subject: string, claims: JwtClaims): Promise<HostAuthPresetUser | null>;
  actAs: ActAs;
  /** The sessionless-door redirect (10-mcp §3). */
  login(request: Request, returnTo: string): Response;
}

/** The three-seam shape every named preset shares (authJs is the template):
    only session decoding, identity defaults, the mint, and the login target
    differ per system. The door's oauth half owns consent/CSRF/replay; this
    only supplies session lookup + subject resolution (10-mcp §3). */
export function composeHostAuthPreset(opts: ComposeHostAuthPresetOptions): HostAuthPreset {
  const principalFor = async (subject: string, claims: JwtClaims): Promise<Principal | null> => {
    const resolved = await opts.resolveUser(subject, claims);
    if (resolved === null) return null;
    return {
      kind: "user",
      subject,
      ...(resolved.display === undefined ? {} : { display: resolved.display }),
    };
  };

  const principal = async (request: Request): Promise<Principal | null> => {
    const claims = await opts.sessionClaims(request);
    if (claims === null) return null;
    const subject = claimString(claims, "sub");
    return subject === undefined ? null : principalFor(subject, claims);
  };

  const oauth: HostOAuthAdapter = {
    async session(request, { returnTo }) {
      const claims = await opts.sessionClaims(request);
      const subject = claims === null ? undefined : claimString(claims, "sub");
      if (subject !== undefined && claims !== null && await opts.resolveUser(subject, claims) !== null) {
        return { subject };
      }
      return opts.login(request, returnTo);
    },
    async principal(subject) {
      return principalFor(subject, {});
    },
  };

  return { principal, actAs: opts.actAs, oauth };
}
