/**
 * Build contract §9.2–§9.3 — `AppsRuntime.access`: what level the CALLER holds
 * on an app, and the grant writes the ✦ share toggle needs.
 *
 * The LEVEL lives here, not on the wire, so the MCP door inherits the same
 * rules without a second copy: `list` needs viewer, grant/revoke need owner, and
 * naming a tenant needs membership in it.
 */
import { VendoError, encodeGrantPrincipal, parseGrantPrincipal, type AppId, type RunContext } from "@vendoai/core";
import { APPS_COLLECTION } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime } from "../runtime/types.js";

export type AccessSurfaceDeps = Pick<AppsRuntimeContext, "config" | "engine" | "holds">;

export const createAccessSurface = ({ config, engine, holds }: AccessSurfaceDeps): AppsRuntime["access"] => {
  /** The seam the WRITES need. `levelFor` and `list` degenerate honestly without
      one, but a grant has nowhere to go. `createVendo` always composes it
      (compose-apps.ts:384 → :187), so this is unreachable there — but
      `createApps` is exported and takes `appAccess?`, and genbench calls it
      without one (genbench/src/vendo.ts:280). A refusal beats a TypeError. */
  const writable = () => {
    if (config.appAccess === undefined) {
      throw new VendoError("not-implemented", "this deployment composes no app-access seam, so it cannot hold grants");
    }
    return config.appAccess;
  };
  /** §9.4's posture in one place: what the caller cannot VIEW stays not-found;
      a proven viewer denied a stronger action gets forbidden. */
  const require = async (appId: Parameters<AppsRuntime["access"]["list"]>[0], ctx: Parameters<AppsRuntime["access"]["list"]>[1], level: "viewer" | "owner") => {
    if (await holds(appId, ctx, level)) return;
    if (level !== "viewer" && await holds(appId, ctx, "viewer")) {
      throw new VendoError("forbidden", `owner access is required for ${appId}`);
    }
    throw new VendoError("not-found", `app not found: ${appId}`);
  };
  /**
   * §9.1 — the memberships the host ASSERTS are the only org chart Vendo has,
   * so naming a tenant is an authorization claim, not a spelling. Owning the app
   * is a SEPARATE gate and does not imply this one: without this check an owner
   * could name any `org:<id>`, `promoteBeforeSharing` would move her app into a
   * stranger's workspace, and that tenant's admins would hold it (their `owner`
   * comes from the row's subject alone, helpers/app-access.ts:117). The store's
   * own guard cannot catch it — it compares the principal against the org
   * HOLDING the row, which the promote just restamped to the named one.
   *
   * `forbidden`, not `not-found`: §9.4 masks what a caller cannot see, and she
   * provably sees this app. It says nothing about whether the org exists.
   *
   * Grant only. A sharer who has since left the tenant must still be able to
   * un-share, and `revoke` never widens access.
   */
  const requireMembership = (principal: string, ctx: RunContext) => {
    const target = parseGrantPrincipal(principal);
    if (target === undefined || target.kind === "user") return;
    if ((ctx.memberships ?? []).some((entry) => entry.org === target.org)) return;
    throw new VendoError("forbidden", `you are not a member of ${target.org}`);
  };

  /**
   * "Share implies promote" (ruled 2026-08-01, pinned at
   * conformance/app-access.ts:181-201). Every create path stamps an app with the
   * PERSON, and core refuses a tenant grant on a still-personal app — the app's
   * documents live under the holder's own `/user` mount, so a share that skipped
   * the move would hand the recipient an empty app. So the share moves it first,
   * in `lifecycle.promote`'s one transaction.
   *
   * ORDER IS THE WHOLE POINT. The move restamps the row's subject as the org id,
   * which retires the promoter's ownership fast path (access-checks.ts:65) — so
   * an owner who is not a tenant ADMIN would lose the app she just shared. Her
   * own owner grant is therefore minted BEFORE the flip, the deliberate
   * exception pinned at store helpers/app-access.ts:186-188.
   *
   * With no `ops` (a store offering neither its own ops nor a SQL handle) there
   * is nothing to move with, and core's own refusal below is the honest answer.
   *
   * NOT ATOMIC with the grant that follows it, and knowingly so. If that last
   * write fails, the app is left in the tenant carrying the sharer's owner grant
   * and no tenant grant, so the tenant's ADMINS can reach it while the caller
   * saw an error. Every alternative is worse. The order is FORCED: the tenant
   * grant cannot go first (core refuses a tenant principal that is not the org
   * holding the row, helpers/app-access.ts:186-188 — that IS the 2026-08-01
   * ruling), and the owner grant cannot go after (paragraph above). One
   * transaction is not on offer either — `AppAccess` is an adapter interface
   * with no transaction, so a hosted or BYO grant write can never join
   * `promote`'s. That leaves a compensating demote: surface the plan excludes,
   * reversing a saga over workspace documents, appData, blobs and bearer tokens,
   * whose own half-failure would be worse than the window it repairs. So the
   * window is ACCEPTED, and kept small by what surrounds it — the target is the
   * caller's own tenant (`requireMembership`), the exposure is that tenant's
   * admins rather than its membership, and the caller keeps owner, so retrying
   * the same share closes it: `promote` is idempotent and the grant write is one
   * derived-id row.
   */
  const promoteBeforeSharing = async (appId: AppId, principal: string, ctx: RunContext) => {
    const target = parseGrantPrincipal(principal);
    if (target === undefined || target.kind === "user" || config.ops === undefined) return;
    const record = await engine.get(APPS_COLLECTION, appId);
    if (record?.refs?.["subject"] === target.org) return;
    await writable().grant(
      ctx,
      appId,
      encodeGrantPrincipal({ kind: "user", subject: ctx.principal.subject }),
      "owner",
    );
    await config.ops.lifecycle.promote(appId, target.org);
  };

  const access: AppsRuntime["access"] = {
    async levelFor(appId, ctx) {
      if (config.appAccess === undefined) {
        // No seam ⇒ no grant row can exist, so ownership is the only level —
        // which is exactly what `holds` degenerates to, at one store read.
        return await holds(appId, ctx, "owner") ? "owner" : null;
      }
      return await config.appAccess.levelFor(ctx, appId);
    },
    async list(appId, ctx) {
      await require(appId, ctx, "viewer");
      // No seam ⇒ no grant row can exist, so the empty list is the honest
      // answer, not a refusal telling a keyless deployment to go buy something.
      return config.appAccess === undefined ? [] : await config.appAccess.list(ctx, appId);
    },
    async grant(appId, principal, level, ctx) {
      await require(appId, ctx, "owner");
      requireMembership(principal, ctx);
      await promoteBeforeSharing(appId, principal, ctx);
      await writable().grant(ctx, appId, principal, level);
      return await access.list(appId, ctx);
    },
    async revoke(appId, principal, ctx) {
      await require(appId, ctx, "owner");
      await writable().revoke(ctx, appId, principal);
      // The revoke LANDED. A caller who just removed their own last grant may
      // no longer read it — that is §9.4 answering a different question, not a
      // failed removal, so answer with what they can still legitimately see.
      return await access.list(appId, ctx).catch((reason: unknown) => {
        if (reason instanceof VendoError && (reason.code === "not-found" || reason.code === "forbidden")) return [];
        throw reason;
      });
    },
  };
  return access;
};
