import type { SecretSource } from "@vendoai/actions/presets";
import type { ActAs, Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";

/** 09-vendo §2.1 — one host-identity story, three seams. A HostAuthPreset fills
    the request→Principal resolver, the away/MCP actAs seam, and the door's
    HostOAuthAdapter from one config key. Passed as `createVendo({ auth })`;
    mutually exclusive with the per-seam `principal`/`actAs`/`oauth` trio. */
export interface HostAuthPreset {
  principal: (req: Request) => Promise<Principal | null>;
  /** Absent → away/MCP execution cleanly unavailable, as ever (01-core §13). */
  actAs?: ActAs;
  /** Absent → the MCP door cannot open (`mcp: true` still requires an adapter, 09 §2). */
  oauth?: HostOAuthAdapter;
}

/** What a host's subject→user resolver returns. `display` names the resolved
    Principal; `email` only feeds actAs session claims (Principal has no email). */
export interface HostAuthPresetUser {
  display?: string;
  email?: string;
}

/** Optional subject→user resolver for custom logic (09 §2.1). `claims` carries
    the decoded session-token claims where a token exists ({} where none does —
    actAs minting and the door's subject lookup). Returning null means "subject
    unknown to host": the principal resolver treats the session as absent, actAs
    declines the mint, and the door's principal lookup returns null. */
export type HostAuthPresetUserResolver = (
  subject: string,
  claims: Record<string, unknown>,
) => HostAuthPresetUser | null | Promise<HostAuthPresetUser | null>;

export interface HostAuthPresetOptions {
  /** The preset's shared session secret (or system-equivalent). Default: the
      provider's own env variable — AUTH_SECRET for Auth.js, SUPABASE_JWT_SECRET
      for Supabase, VENDO_AWAY_TOKEN_SECRET (the away-token secret) for
      Clerk/Auth0 — resolved lazily per call so composition order never races
      env loading. jwt() has no vendor env to read: its secret is required. */
  secret?: SecretSource;
  user?: HostAuthPresetUserResolver;
}
