import type { SecretSource } from "@vendoai/actions/presets";
import type { ActAs, Json, Membership, Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";

/** 09-vendo §2.1 — one host-identity story, three seams. A HostAuthPreset fills
    the request→Principal resolver, the away/MCP actAs seam, and the door's
    HostOAuthAdapter from one config key. Passed as `createVendo({ auth })`;
    mutually exclusive with the per-seam `principal`/`actAs`/`oauth` trio. */
export interface HostAuthPreset {
  /** Which preset this is, spelled the way a host writes it in config — `clerk`,
      `auth0`, `supabase`, `authJs`, `jwt`. The boot summary shows it, so one
      line tells an operator which identity story is actually live.

      Optional, and absent on purpose for a preset a HOST composed itself (the
      demo's `mapleAuth` is one): there is no vendor to name, and inventing one
      would be a lie. Nothing but the summary reads it — never branch on it. */
  readonly name?: string;
  principal: (req: Request) => Promise<Principal | null>;
  /** Absent → away/MCP execution cleanly unavailable, as ever (01-core §13). */
  actAs?: ActAs;
  /** Absent → the MCP door cannot open (`mcp: true` still requires an adapter, 09 §2). */
  oauth?: HostOAuthAdapter;
  /** Build contract §9.1 — the fourth seam: the caller's orgs and teams, one
      query against the host's OWN tables. Keyed on `Principal`, not `Request`,
      which is what makes it callable for unattended runs (a fire-time sponsor
      check has no session, and the callback is host server code in the same
      deployment). Absent → no orgs asserted → `can()` degenerates to
      ownership. Never persisted anywhere. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** Spec 2026-08-05 §1 — the host's asserted profile facts for the request's
      user, resolved from the SAME session decode as `principal` (the composed
      presets memoize per Request). The wire stashes the result as `ctx.user`,
      which the prompt renders as the `[User]` block; absent/undefined → no
      block. Preset-only: the raw per-seam `principal` trio has no facts channel. */
  facts?: (req: Request) => Promise<Record<string, Json> | undefined>;
}

/** What a host's subject→user resolver returns. `display` names the resolved
    Principal; `email` only feeds actAs session claims (Principal has no email). */
export interface HostAuthPresetUser {
  display?: string;
  email?: string;
  /** Arbitrary host-asserted facts about the user (plan, role, tenure, …).
      Server-trust and MODEL-VISIBLE: they flow to `ctx.user` and render as the
      prompt's `[User]` block every turn — data only, never secrets. */
  facts?: Record<string, Json>;
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
  /** Build contract §9.1 — see HostAuthPreset.memberships. Every preset
      forwards this verbatim; nothing about it is vendor-specific, because the
      org chart it reads is the HOST's, not the identity vendor's. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
}
