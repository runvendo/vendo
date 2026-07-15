import type { ActAs, AuthMaterial } from "@vendoai/core";
import {
  TokenCache,
  assertLifetime,
  resolveClaims,
  resolveSecret,
  secretFingerprint,
  stableJson,
  type ClaimsOption,
  type JwtClaims,
  type SecretSource,
} from "./shared.js";

type AuthJsEncode = (options: {
  token: JwtClaims;
  secret: string;
  salt: string;
  maxAge: number;
}) => Promise<string>;

export interface AuthJsPresetOptions {
  /** The host's Auth.js secret. Defaults to AUTH_SECRET. */
  secret?: SecretSource;
  /** Must match the host's session cookie name because Auth.js uses it as the JWE salt. */
  cookieName?: string;
  /** Use Auth.js's `__Secure-` production cookie default when cookieName is omitted. */
  secureCookie?: boolean;
  claims?: ClaimsOption;
  expiresInSeconds?: number;
  cacheSafetySeconds?: number;
}

/** Mint an Auth.js v5 encrypted session JWE using @auth/core's own encoder. */
export function authJsPreset(options: AuthJsPresetOptions = {}): ActAs {
  const expiresInSeconds = options.expiresInSeconds ?? 300;
  const cacheSafetySeconds = options.cacheSafetySeconds ?? 30;
  const cookieName = options.cookieName
    ?? (options.secureCookie ? "__Secure-authjs.session-token" : "authjs.session-token");
  assertLifetime(expiresInSeconds, cacheSafetySeconds);
  const cache = new TokenCache();
  let encodePromise: Promise<AuthJsEncode> | undefined;
  const loadEncode = (): Promise<AuthJsEncode> => {
    encodePromise ??= import("@auth/core/jwt")
      .then((module) => module.encode as unknown as AuthJsEncode);
    return encodePromise;
  };

  return async (principal, grant): Promise<AuthMaterial | null> => {
    const secret = await resolveSecret(options.secret, "AUTH_SECRET");
    if (!secret) return null;
    const additionalClaims = await resolveClaims(options.claims, principal, grant);
    if (additionalClaims === null) return null;
    const claims: JwtClaims = { ...additionalClaims, sub: principal.subject };
    const nowMs = Date.now();
    const key = stableJson({
      secret: await secretFingerprint(secret),
      cookieName,
      claims,
    });
    let token = cache.get(key, nowMs, cacheSafetySeconds * 1000);
    if (!token) {
      const encode = await loadEncode();
      token = await encode({ token: claims, secret, salt: cookieName, maxAge: expiresInSeconds });
      cache.set(key, token, (Math.floor(nowMs / 1000) + expiresInSeconds) * 1000, nowMs);
    }
    return { headers: { cookie: `${cookieName}=${token}` } };
  };
}
