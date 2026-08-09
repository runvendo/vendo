/**
 * The two audit mints `createApps` reports through — an app-lifecycle event
 * under an explicit subject, and one under the calling principal. Lifted out of
 * `createApps` unchanged.
 */
import { type AppId, type Json, type RunContext } from "@vendoai/core";
import { appLifecycleEvent } from "./audit.js";
import type { AppsConfig } from "./types.js";

export const createAuditReporters = (config: AppsConfig) => {
  const reportGuard = async (
    principalSubject: string,
    appId: AppId,
    // Every field the ROW depends on is named here. It used to stop at
    // venue/presence/trigger, and `turnId` survived only because every caller
    // happens to hand over a whole ctx — so the first caller to pass a literal
    // would have dropped it silently. Naming it makes that a typecheck failure.
    ctx: Pick<RunContext, "venue" | "presence" | "trigger" | "turnId">,
    detail: Record<string, Json>,
  ): Promise<void> => {
    await config.guard.report(
      appLifecycleEvent({ kind: "user", subject: principalSubject }, ctx, appId, detail),
    );
  };

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork" | "in-client-approve" | "pin-fork" | "pin-rebase" | "machine-provision" | "place" | "unplace",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await config.guard.report(appLifecycleEvent(ctx.principal, ctx, appId, { operation, ...extra }));
  };

  return { reportGuard, reportLifecycle };
};
