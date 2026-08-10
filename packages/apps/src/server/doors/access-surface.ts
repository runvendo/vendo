/**
 * Build contract §9.3 — `AppsRuntime.access`: what level the CALLER holds on
 * an app.
 *
 * A read, and only a read. The grant-writing doors that used to sit beside it
 * (`list`/`grant`/`revoke`/`holder`) existed for the Share dialog, which no
 * host ever mounted; they went with it. Grant ROWS are still written and read
 * through the `AppAccess` seam (`config.appAccess`) — this surface just never
 * had a caller for that half.
 */
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime } from "../runtime/types.js";

export type AccessSurfaceDeps = Pick<AppsRuntimeContext, "config" | "holds">;

export const createAccessSurface = ({ config, holds }: AccessSurfaceDeps): AppsRuntime["access"] => ({
  async levelFor(appId, ctx) {
    if (config.appAccess === undefined) {
      // No seam ⇒ no grant row can exist, so ownership is the only level —
      // which is exactly what `holds` degenerates to, at one store read.
      return await holds(appId, ctx, "owner") ? "owner" : null;
    }
    return await config.appAccess.levelFor(ctx, appId);
  },
});
