import type { ActAs } from "@vendoai/core";
import { genericJwtPreset } from "./generic-jwt.js";
import { resolveClaims, type ClaimsOption, type SecretSource } from "./shared.js";

export interface SupabasePresetOptions {
  /** The project's legacy JWT secret. Defaults to SUPABASE_JWT_SECRET. */
  secret?: SecretSource;
  audience?: string;
  role?: string;
  claims?: ClaimsOption;
  expiresInSeconds?: number;
  cacheSafetySeconds?: number;
}

/** Mint a native Supabase Auth HS256 access token without contacting Supabase. */
export function supabasePreset(options: SupabasePresetOptions = {}): ActAs {
  const audience = options.audience ?? "authenticated";
  const role = options.role ?? "authenticated";
  return genericJwtPreset({
    secret: options.secret ?? (() => process.env.SUPABASE_JWT_SECRET),
    expiresInSeconds: options.expiresInSeconds,
    cacheSafetySeconds: options.cacheSafetySeconds,
    jwtHeader: { typ: "JWT" },
    claims: async (principal, grant) => {
      const additional = await resolveClaims(options.claims, principal, grant);
      if (additional === null) return null;
      return {
        ...additional,
        sub: principal.subject,
        role,
        aud: audience,
      };
    },
  });
}
