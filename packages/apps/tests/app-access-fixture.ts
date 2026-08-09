import {
  VendoError,
  accessForPath,
  grantMatches,
  holdsLevel,
  parseGrantPrincipal,
  strongerLevel,
  type AccessLevel,
  type AppAccess,
  type AppGrantRecord,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import type { memoryStore } from "./memory-store.js";

/**
 * A stand-in for `appAccess(store)` over the same rows: the real function lives
 * in @vendoai/store and `apps → core` is the only edge layering allows the
 * runtime (or its tests).
 *
 * Every RULE it applies comes from core (`accessForPath`, `grantMatches`,
 * `strongerLevel`, `holdsLevel`, `parseGrantPrincipal`) — the very functions the
 * real implementation applies — so all that is left here is reading rows, and
 * there is nothing for the two to disagree about. What remains is pinned by
 * core's `appAccessConformance` kit, which BOTH suites mount (access.test.ts
 * here, app-access.test.ts in @vendoai/store): a rule that moves on either side
 * fails on both. Before that, mutating the real `can()` to `return true` left
 * this file's suite entirely green.
 */
export function storeAccessFixture(store: ReturnType<typeof memoryStore>): AppAccess {
  const grants = store.records("vendo_app_grants");
  const apps = store.records("vendo_apps");

  const rowSubject = async (appId: AppId): Promise<string | undefined> =>
    (await apps.get(appId))?.refs?.["subject"];

  const rowsFor = async (appId: AppId): Promise<AppGrantRecord[]> =>
    (await grants.list({ refs: { app_id: appId } })).records.map((record) => ({
      ...record.data as Omit<AppGrantRecord, "id" | "createdAt">,
      id: record.id,
      createdAt: record.createdAt,
    }));

  /** §9.4 posture: masked when they cannot see it, `forbidden` when they can. */
  const require = async (runCtx: RunContext, appId: AppId, level: AccessLevel): Promise<void> => {
    const held = await access.levelFor(runCtx, appId);
    if (held === null) throw new VendoError("not-found", `app not found: ${appId}`);
    if (!holdsLevel(held, level)) {
      throw new VendoError("forbidden", `${level} access is required for ${appId}`);
    }
  };

  const access: AppAccess = {
    async levelFor(runCtx, appId) {
      const subject = await rowSubject(appId);
      if (subject === undefined) return null;
      if (subject === runCtx.principal.subject) return "owner";
      let level: AccessLevel | null =
        (runCtx.memberships ?? []).some((m) => m.org === subject && m.admin === true) ? "owner" : null;
      for (const row of await rowsFor(appId)) {
        if (grantMatches(runCtx, row.principal)) level = strongerLevel(level, row.level);
      }
      return level;
    },

    async can(runCtx, level, thing) {
      if ("path" in thing) {
        const resolved = accessForPath(runCtx, level, thing.path);
        return "app" in resolved
          ? await access.can(runCtx, level, { app: resolved.app })
          : resolved.decision;
      }
      return holdsLevel(await access.levelFor(runCtx, thing.app), level);
    },

    async grant(runCtx, appId, principal, level) {
      await require(runCtx, appId, "owner");
      const orgId = await rowSubject(appId) ?? "";
      const named = parseGrantPrincipal(principal);
      if (named === undefined) {
        throw new VendoError("validation", `unknown grant principal encoding: ${principal}`);
      }
      if (named.kind !== "user" && named.org !== orgId) {
        throw new VendoError(
          "validation",
          `this app is not in ${named.org}'s workspace, so ${named.org} cannot be given access to it`
          + ` — move the app into ${named.org} first (sharing offers to), then share it`,
        );
      }
      // "Share implies promote" for a PERSON too (design §8, ruled 2026-08-01):
      // see the same refusal in @vendoai/store's appAccess, pinned by core's
      // conformance kit that both mount.
      const heldByAnOrg = (runCtx.memberships ?? []).some((entry) => entry.org === orgId);
      if (named.kind === "user" && named.subject !== orgId && !heldByAnOrg) {
        throw new VendoError(
          "validation",
          "this app is still one person's, so another person cannot be given access to it"
          + " — move it into a team first (sharing offers to), or fork a copy for them",
        );
      }
      const existing = (await rowsFor(appId)).find((row) => row.principal === principal);
      await grants.put({
        id: existing?.id ?? `ag_${appId}_${principal}`,
        data: { appId, orgId, principal, level, createdBy: runCtx.principal.subject },
        refs: { app_id: appId, principal, level },
      });
    },

    async revoke(runCtx, appId, principal) {
      await require(runCtx, appId, "owner");
      const existing = (await rowsFor(appId)).find((row) => row.principal === principal);
      if (existing !== undefined) await grants.delete(existing.id);
    },

    async list(runCtx, appId) {
      await require(runCtx, appId, "viewer");
      return await rowsFor(appId);
    },
  };
  return access;
}

/** Seed grants the way the Share dialog would, without going through the
    owner gate (these cases set the world up, they do not test the setup). */
export const seedGrantRows = async (
  store: ReturnType<typeof memoryStore>,
  appId: string,
  levels: Record<string, AccessLevel>,
): Promise<void> => {
  for (const [principal, level] of Object.entries(levels)) {
    await store.records("vendo_app_grants").put({
      id: `ag_${appId}_${principal}`,
      data: { appId, orgId: "acme", principal, level, createdBy: "dana" },
      refs: { app_id: appId, principal, level },
    });
  }
};
