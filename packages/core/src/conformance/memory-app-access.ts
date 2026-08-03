import {
  accessForPath,
  grantMatches,
  holdsLevel,
  parseGrantPrincipal,
  strongerLevel,
  type AccessLevel,
  type AppAccess,
  type AppGrantRecord,
} from "../app-access.js";
import { VendoError } from "../errors.js";
import type { AppId } from "../ids.js";
import type { RunContext } from "../run-context.js";

/**
 * The in-memory reference `AppAccess`, alongside `memoryStoreAdapter` and
 * `memoryKnowledgeAdapter`: every conformance kit core ships gets one
 * implementation core itself can mount, so the RULE and a working example of it
 * ship together and the kit is proven executable before any host wires a real
 * store to it.
 *
 * It holds rows in maps and nothing else. Every DECISION comes from the pure
 * half of `can()` in ../app-access.ts — `accessForPath`, `grantMatches`,
 * `strongerLevel`, `holdsLevel`, `parseGrantPrincipal` — which is the same set
 * `appAccess(store)` in @vendoai/store applies. That is the point: this is a
 * second store, never a second rule, so it cannot drift from the real one on
 * anything `appAccessConformance` asks about.
 */
export interface MemoryAppAccess {
  access: AppAccess;
  /** Put an app row owned by `subject` (a person, or an org id). */
  seedApp(appId: AppId, subject: string): Promise<void>;
  /** Put a grant row directly, WITHOUT the owner gate — for setting a world up. */
  seedGrant(appId: AppId, principal: string, level: AccessLevel): Promise<void>;
}

export function memoryAppAccess(): MemoryAppAccess {
  /** appId → the owning subject (a person, or an org id). */
  const owners = new Map<string, string>();
  /** appId → principal → row. */
  const grants = new Map<string, Map<string, AppGrantRecord>>();

  const rowsFor = (appId: AppId): AppGrantRecord[] => [...(grants.get(appId)?.values() ?? [])];

  const put = (appId: AppId, principal: string, level: AccessLevel, createdBy: string): void => {
    const forApp = grants.get(appId) ?? new Map<string, AppGrantRecord>();
    forApp.set(principal, {
      // Re-granting UPDATES the one row for this principal rather than accreting
      // a second — two rows for one principal is an unrevokable grant.
      id: `ag_${appId}_${principal}`,
      appId,
      orgId: owners.get(appId) ?? "",
      principal,
      level,
      createdBy,
      createdAt: new Date().toISOString(),
    });
    grants.set(appId, forApp);
  };

  const access: AppAccess = {
    async levelFor(ctx, appId) {
      const subject = owners.get(appId);
      // §9.4 posture: an app nobody can see is indistinguishable from one that
      // does not exist, so both answer null and the callers below mask as
      // not-found rather than forbidden.
      if (subject === undefined) return null;
      if (subject === ctx.principal.subject) return "owner";
      let level: AccessLevel | null = (ctx.memberships ?? [])
        .some((membership) => membership.org === subject && membership.admin === true) ? "owner" : null;
      for (const row of rowsFor(appId)) {
        if (grantMatches(ctx, row.principal)) level = strongerLevel(level, row.level);
      }
      return level;
    },

    async can(ctx, level, thing) {
      if ("path" in thing) {
        const resolved = accessForPath(ctx, level, thing.path);
        return "app" in resolved ? await access.can(ctx, level, { app: resolved.app }) : resolved.decision;
      }
      return holdsLevel(await access.levelFor(ctx, thing.app), level);
    },

    async grant(ctx, appId, principal, level) {
      await requireLevel(ctx, appId, "owner");
      const orgId = owners.get(appId) ?? "";
      const named = parseGrantPrincipal(principal);
      if (named === undefined) {
        throw new VendoError("validation", `unknown grant principal encoding: ${principal}`);
      }
      if (named.kind !== "user" && named.org !== orgId) {
        throw new VendoError(
          "validation",
          `this app is not in ${named.org}'s workspace, so ${named.org} cannot be given access to it`,
        );
      }
      // "Share implies promote" for a PERSON too (design §8, ruled 2026-08-01):
      // an app still under one person's `/user` mount has no directory another
      // person could ever open, so the grant would resolve onto nothing. The
      // promoter's OWN row is the exception — promote mints it before the app
      // row flips, and locking the giver out is not a sharing model.
      const heldByAnOrg = (ctx.memberships ?? []).some((membership) => membership.org === orgId);
      if (named.kind === "user" && named.subject !== orgId && !heldByAnOrg) {
        throw new VendoError(
          "validation",
          "this app is still one person's, so another person cannot be given access to it",
        );
      }
      put(appId, principal, level, ctx.principal.subject);
    },

    async revoke(ctx, appId, principal) {
      await requireLevel(ctx, appId, "owner");
      grants.get(appId)?.delete(principal);
    },

    async list(ctx, appId) {
      await requireLevel(ctx, appId, "viewer");
      return rowsFor(appId);
    },
  };

  /** §9.4 posture: masked when they cannot see it, forbidden when they can. */
  async function requireLevel(ctx: RunContext, appId: AppId, level: AccessLevel): Promise<void> {
    const held = await access.levelFor(ctx, appId);
    if (held === null) throw new VendoError("not-found", `app not found: ${appId}`);
    if (!holdsLevel(held, level)) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
  }

  return {
    access,
    async seedApp(appId, subject) {
      owners.set(appId, subject);
    },
    async seedGrant(appId, principal, level) {
      put(appId, principal, level, "seed");
    },
  };
}
