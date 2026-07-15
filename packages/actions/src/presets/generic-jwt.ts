import type { ActAs, AuthMaterial } from "@vendoai/core";
import {
  TokenCache,
  assertLifetime,
  resolveClaims,
  resolveSecret,
  secretFingerprint,
  signHs256,
  stableJson,
  type ClaimsOption,
  type JwtClaims,
  type SecretSource,
} from "./shared.js";

export interface GenericJwtPresetOptions {
  /** An HS256 secret or lazy secret resolver. An unavailable secret declines actAs. */
  secret?: SecretSource;
  /** Static claims or a resolver. Returning null declines actAs for that principal/grant. */
  claims?: ClaimsOption;
  /** Extra protected-header fields. `alg` is always forced to HS256. */
  jwtHeader?: JwtClaims;
  /** Convert the compact JWT to AuthMaterial headers. Defaults to Authorization: Bearer. */
  headers?: (token: string) => Record<string, string>;
  expiresInSeconds?: number;
  cacheSafetySeconds?: number;
}

/** Configurable HS256 actAs for hosts with a conventional shared-secret JWT verifier. */
export function genericJwtPreset(options: GenericJwtPresetOptions): ActAs {
  const expiresInSeconds = options.expiresInSeconds ?? 300;
  const cacheSafetySeconds = options.cacheSafetySeconds ?? 30;
  assertLifetime(expiresInSeconds, cacheSafetySeconds);
  const cache = new TokenCache();
  const toHeaders = options.headers ?? ((token: string) => ({ authorization: `Bearer ${token}` }));

  return async (principal, grant): Promise<AuthMaterial | null> => {
    const secret = await resolveSecret(options.secret);
    if (!secret) return null;
    const additionalClaims = await resolveClaims(options.claims, principal, grant);
    if (additionalClaims === null) return null;
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const payload: JwtClaims = {
      sub: principal.subject,
      ...additionalClaims,
      iat: nowSeconds,
      exp: nowSeconds + expiresInSeconds,
    };
    const key = stableJson({
      secret: await secretFingerprint(secret),
      payload: { ...payload, iat: undefined, exp: undefined },
      header: options.jwtHeader ?? {},
    });
    let token = cache.get(key, nowMs, cacheSafetySeconds * 1000);
    if (!token) {
      token = await signHs256(payload, secret, options.jwtHeader);
      cache.set(key, token, (nowSeconds + expiresInSeconds) * 1000);
    }
    return { headers: { ...toHeaders(token) } };
  };
}

export type { ClaimsOption, ClaimsResolver, JwtClaims, SecretSource } from "./shared.js";
