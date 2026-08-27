import type { SecretSource } from "@vendoai/actions/presets";
import type { ActAs, Json, Membership, Principal } from "@vendoai/core";
import type { HostOAuthAdapter } from "@vendoai/mcp";

/** 09-vendo §2.1 — one host-identity story, every seam. This is what the ONE
    DOOR `createVendo({ auth })` takes, in either of its two spellings:

      auth: authJs()                       // a preset's result
      auth: { principal, facts }           // an object you write

    They are the same value: a preset is a function that RETURNS one of these,
    so nothing is reserved to the preset path. Every member below is meant to be
    hand-written when a host has no vendor to name, and `principal` is the only
    required one — the rest each degrade to a documented "absent" behavior.

    Mutually exclusive with the deprecated per-seam `principal`/`actAs`/`oauth`
    trio: mixing throws at compose time. */
export interface HostAuthPreset {
  /** Host session → who is asking. `null` = this visitor has no identity, and
      the request is refused with `forbidden`; give logged-out visitors a
      principal of your own if you want them served. The one required member —
      Vendo mints no principals of its own. */
  principal: (req: Request) => Promise<Principal | null>;
  /** Spec 2026-08-05 §1 — the host's asserted profile facts for the request's
      user, resolved from the SAME request as `principal` (the shipped presets
      memoize the session decode per Request; a hand-written pair should too if
      the lookup is expensive). The wire stashes the result as `ctx.user`, which
      the prompt renders as the `[User]` block; absent/undefined → no block.

      Model-visible, verbatim: data only, never secrets. */
  facts?: (req: Request) => Promise<Record<string, Json> | undefined>;
  /** The named shared meters this request's user's usage ALSO counts into, pool
      name → the id it accrues to (`{ workspace: "ws_maple" }`). Resolved from
      the same request as `principal`. The wire stashes the result as
      `ctx.pools`, which the limits policy reads; absent/undefined → the user's
      own meter only. Never rendered to the model. */
  pools?: (req: Request) => Promise<Record<string, string> | undefined>;
  /** Build contract §9.1 — the caller's orgs and teams, one query against the
      host's OWN tables. Keyed on `Principal`, not `Request`, which is what makes
      it callable for unattended runs (a fire-time sponsor check has no session,
      and the callback is host server code in the same deployment). Absent → no
      orgs asserted → `can()` degenerates to ownership. Never persisted
      anywhere. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
  /** Scoped auth material for away host-API execution — the host mints a token
      for `principal` bounded by `grant`. Hand-written this is usually
      `genericJwtPreset({ secret })` from `@vendoai/actions/presets`, or your own
      minting call. Absent → away/MCP execution cleanly unavailable, as ever
      (01-core §13). */
  actAs?: ActAs;
  /** The MCP door's session lookup and subject→principal resolution — hand it
      the same session decode `principal` uses, plus a redirect for a request
      that carries none. Absent → the MCP door cannot open (`mcp: true` still
      requires an adapter, 09 §2). */
  oauth?: HostOAuthAdapter;
  /** Which SHIPPED preset this is, spelled the way a host writes it in config —
      `clerk`, `auth0`, `supabase`, `authJs`, `jwt`. The boot summary shows it,
      so one line tells an operator which identity story is actually live.

      Leave it off in an object you write by hand: there is no vendor to name,
      and inventing one would be a lie. Nothing but the summary reads it — never
      branch on it. */
  readonly name?: string;
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
  /** Named shared meters this user's usage also counts into, pool name → the
      id it accrues to (`{ workspace: "ws_maple" }`). They flow to `ctx.pools`
      for the limits policy — never rendered to the model. */
  pools?: Record<string, string>;
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
