import type { SecretSource } from "@vendoai/actions/presets";
import type { ActAs, Json, Membership, Principal, ResolvedPerson } from "@vendoai/core";
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
  /** Build contract §9.1 — the fourth seam: the caller's orgs and teams, one
      query against the host's OWN tables. Keyed on `Principal`, not `Request`,
      which is what makes it callable for unattended runs (a fire-time sponsor
      check has no session, and the callback is host server code in the same
      deployment). Absent → no orgs asserted → `can()` degenerates to
      ownership. Never persisted anywhere. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** Build contract §9.1 companion — the fifth seam: turn what someone TYPED
      into the Share dialog ("Mia", "mia@work.com") into one of the host's own
      subjects, or null. Vendo holds no directory, so a person-share cannot be
      resolved here; the dialog used to encode the typed string verbatim and
      write a grant that matched nobody. Absent → the dialog does not offer to
      share with one person at all (teams, orgs and fork are unaffected).

      `asker` is WHO is asking, so the host can scope its own directory — "only
      people in the asker's own org" is the common rule and it is unimplementable
      without this. Keyed on Principal for the same reason `memberships` is. Vendo
      also gates the door on the asker holding at least one asserted membership,
      but only the host knows its own org chart. */
  resolvePerson?: (query: string, asker: Principal) => Promise<ResolvedPerson | null>;
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
  /** Build contract §9.1 companion — see HostAuthPreset.resolvePerson. Forwarded
      verbatim by every preset, for the same reason `memberships` is: the
      directory it reads is the HOST's, and so is the decision about who may see
      which part of it. */
  resolvePerson?: (query: string, asker: Principal) => Promise<ResolvedPerson | null>;
}
