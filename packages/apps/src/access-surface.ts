/**
 * Build contract §9.2–§9.3 — `AppsRuntime.access`, the Share dialog's door.
 *
 * Lifted out of `createApps` unchanged: `list` is viewer-gated and OSS;
 * `grant`/`revoke` are owner-gated AND Cloud-gated (sharing is multi-party
 * coordination). `can()` behind them is never key-conditional.
 */
import { VendoError } from "@vendoai/core";
import type { AppsRuntimeContext } from "./runtime-context.js";
import type { AppsRuntime } from "./types.js";

export type AccessSurfaceDeps = Pick<
  AppsRuntimeContext,
  "config" | "apps" | "holds" | "requireMultiParty" | "requireAccess" | "reportShare"
>;

export const createAccessSurface = (deps: AccessSurfaceDeps): AppsRuntime["access"] => {
  const { config, apps, holds, requireMultiParty, requireAccess, reportShare } = deps;
  return {
  async list(appId, ctx) {
    if (config.appAccess === undefined) {
      // No seam wired ⇒ no grant row can exist (§9.6), so the empty list is
      // the honest answer — the same absence `levelFor` reports without
      // throwing. A 402 from a READ told the Share dialog to go buy
      // something on every keyless (default OSS) deployment. Still
      // viewer-gated: a caller who cannot see the app is told nothing.
      const record = await apps.get(appId);
      if (record === null || !(await holds(appId, ctx, "viewer", record))) {
        throw new VendoError("not-found", `app not found: ${appId}`);
      }
      return [];
    }
    return await config.appAccess.list(ctx, appId);
  },
  async grant(appId, principal, level, ctx) {
    requireMultiParty("sharing");
    await requireAccess().grant(ctx, appId, principal, level);
    await reportShare(appId, ctx, { operation: "grant", principal, level });
  },
  async revoke(appId, principal, ctx) {
    requireMultiParty("sharing");
    await requireAccess().revoke(ctx, appId, principal);
    await reportShare(appId, ctx, { operation: "revoke", principal });
  },
  async levelFor(appId, ctx) {
    if (config.appAccess === undefined) {
      // No seam ⇒ no grant row can exist, so ownership is the only level —
      // which is exactly what `holds` degenerates to, at one store read.
      return await holds(appId, ctx, "owner") ? "owner" : null;
    }
    return await config.appAccess.levelFor(ctx, appId);
  },
  async holder(appId, ctx) {
    // Viewer-gated like the grant list: a caller who cannot see the app is
    // told nothing about who holds it.
    const record = await apps.get(appId);
    if (record === null || !(await holds(appId, ctx, "viewer", record))) return null;
    return record.refs?.subject ?? null;
  },
  };
};
