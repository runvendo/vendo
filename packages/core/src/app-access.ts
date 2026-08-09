import type { AppId, IsoDateTime } from "./ids.js";
import type { RunContext } from "./run-context.js";

/**
 * Build contract §9.3 — the `can()` seam.
 *
 * The SHAPE lives here and the implementation lives in `@vendoai/store`
 * (`appAccess(store)`, re-exported from there): the apps runtime, the wire and
 * the MCP door all speak this interface, and `apps → core` is the only edge
 * layering allows them (dependency-guard). Same split as `Check`/`Finding`.
 */

/** The closed, ORDERED level vocabulary. Assignments are fully flexible;
    defining new level types is deliberately not a surface. */
export type AccessLevel = "viewer" | "editor" | "owner";

/** What `can()` is asked about: an app, or a workspace path. */
export type CanThing = { app: AppId } | { path: string };

/** One stored grant (build contract §9.2) — the only multi-party rows Vendo
    keeps. `principal` is one string: `user:<subject>` · `team:<orgId>/<teamId>`
    · `org:<orgId>`, matched against the memberships the host ASSERTS. */
export interface AppGrantRecord {
  id: string;
  appId: AppId;
  orgId: string;
  principal: string;
  level: AccessLevel;
  /** The granting subject, for audit. */
  createdBy: string;
  createdAt: IsoDateTime;
}

/** Build contract §9.3 — one function, three doors. */
export interface AppAccess {
  can(ctx: RunContext, level: AccessLevel, thing: CanThing): Promise<boolean>;
  levelFor(ctx: RunContext, appId: AppId): Promise<AccessLevel | null>;
  grant(ctx: RunContext, appId: AppId, principal: string, level: AccessLevel): Promise<void>;
  revoke(ctx: RunContext, appId: AppId, principal: string): Promise<void>;
  list(ctx: RunContext, appId: AppId): Promise<AppGrantRecord[]>;
}

/* ------------------------------------------------------------------------- *
 * The PURE half of `can()`: the principal grammar, the level order, and the
 * path rules. It lives here, beside the shapes, because two packages resolve
 * access — @vendoai/store over real rows and @vendoai/apps' test stand-in over
 * a memory store — and a second copy of these rules is how a permission check
 * rots. Nothing below touches a store; every function is a total function of
 * its arguments.
 * ------------------------------------------------------------------------- */

/** The closed level ORDER. `viewer < editor < owner`. */
export const ACCESS_RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };

/** Does a held level satisfy a required one? `null` = no access at all. */
export const holdsLevel = (held: AccessLevel | null, needed: AccessLevel): boolean =>
  held !== null && ACCESS_RANK[held] >= ACCESS_RANK[needed];

/** Effective access is the MAX of what applies (§9.3). */
export const strongerLevel = (
  left: AccessLevel | null,
  right: AccessLevel | null,
): AccessLevel | null => {
  if (left === null) return right;
  if (right === null) return left;
  return ACCESS_RANK[left] >= ACCESS_RANK[right] ? left : right;
};

/** The §9.2 principal encoding, parsed. One string, ref-queryable. */
export type GrantPrincipal =
  | { kind: "user"; subject: string }
  | { kind: "team"; org: string; team: string }
  | { kind: "org"; org: string };

export function parseGrantPrincipal(encoded: string): GrantPrincipal | undefined {
  const separator = encoded.indexOf(":");
  if (separator === -1) return undefined;
  const kind = encoded.slice(0, separator);
  const rest = encoded.slice(separator + 1);
  if (rest === "") return undefined;
  if (kind === "user") return { kind: "user", subject: rest };
  if (kind === "org") return rest.includes("/") ? undefined : { kind: "org", org: rest };
  if (kind === "team") {
    const slash = rest.indexOf("/");
    if (slash === -1) return undefined;
    const org = rest.slice(0, slash);
    const team = rest.slice(slash + 1);
    if (org === "" || team === "" || team.includes("/")) return undefined;
    return { kind: "team", org, team };
  }
  return undefined;
}

export function isGrantPrincipal(encoded: string): boolean {
  return parseGrantPrincipal(encoded) !== undefined;
}

/**
 * Build contract §9.1 companion (ratified 2026-08-01) — what the HOST's own
 * identity system answers when asked to turn a typed name into one of its own
 * subjects.
 *
 * Vendo holds no directory (locked: the host's identity system IS the org), so
 * "Mia" cannot be resolved here and must not be pretended at: the surface that
 * asked used to encode whatever was typed VERBATIM as the subject, which wrote a
 * `user:` grant that matched nobody — after the app had already moved into the
 * team. The `user:` principal is minted from `subject`, never from the query.
 *
 * The seam that produces this takes `(query, asker)`: only the host can scope its
 * own directory, and "people in the asker's own org" is unimplementable if the
 * host is never told who asked. Vendo's own half of that is the door, which
 * refuses an asker holding no asserted membership at all.
 */
export interface ResolvedPerson {
  /** The host's own stable subject — the one the grant is written for. */
  subject: string;
  /** Consumer-voice name, so the asking surface can confirm WHO it matched. */
  display?: string;
}

/** Render the encoding, so no caller has to know the grammar. */
export function encodeGrantPrincipal(target: GrantPrincipal): string {
  if (target.kind === "user") return `user:${target.subject}`;
  if (target.kind === "org") return `org:${target.org}`;
  return `team:${target.org}/${target.team}`;
}

/** `/orgs/<orgId>/**` → the org. Owner derivation is a pure function of the
    path (§9.7), and this is that function. */
export function orgOfPath(path: string): string | undefined {
  return /^\/orgs\/([^/]+)(?:\/|$)/.exec(path)?.[1];
}

/** `/orgs/<orgId>/apps/<appId>` and everything under it — the app grant governs
    the whole subtree INCLUDING its root, or a member holding no grant could
    write the root as a file and the app's own subtree could never exist. */
export function appOfOrgPath(path: string): AppId | undefined {
  return /^\/orgs\/[^/]+\/apps\/([^/]+)(?:\/|$)/.exec(path)?.[1] as AppId | undefined;
}

/** Does an ASSERTED membership satisfy this grant row's principal? Memberships
    come from the ctx only — Vendo has no org chart to query (§9.1). */
export function grantMatches(ctx: RunContext, encoded: string): boolean {
  const principal = parseGrantPrincipal(encoded);
  if (principal === undefined) return false;
  if (principal.kind === "user") return principal.subject === ctx.principal.subject;
  const membership = (ctx.memberships ?? []).find((entry) => entry.org === principal.org);
  if (membership === undefined) return false;
  return principal.kind === "org" || (membership.teams ?? []).includes(principal.team);
}

/**
 * §9.3's path variant, decided as far as it can be without rows: either the
 * answer, or the app whose grants govern the rest.
 */
export type PathAccess = { decision: boolean } | { app: AppId };

export function accessForPath(ctx: RunContext, level: AccessLevel, path: string): PathAccess {
  // `/user/**` is the bound subject's, at every level, exactly as it always was.
  if (path === "/user" || path.startsWith("/user/")) return { decision: true };
  const org = orgOfPath(path);
  if (org === undefined) return { decision: false };
  const membership = (ctx.memberships ?? []).find((entry) => entry.org === org);
  if (membership === undefined) return { decision: false };
  // The org's policy file is the org admins' (§9.10 is lane H's; the mount rule
  // is §9.7's): everyone in the org reads it, only an admin rewrites it.
  if (path === `/orgs/${org}/policy.json`) {
    return { decision: level === "viewer" || membership.admin === true };
  }
  const app = appOfOrgPath(path);
  // An app's subtree is governed by the app's own grants; the rest of the org
  // mount is the membership's.
  return app === undefined ? { decision: true } : { app };
}
