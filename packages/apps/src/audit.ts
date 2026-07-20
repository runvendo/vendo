import type {
  AppId,
  AuditEvent,
  Json,
  Principal,
  RunContext,
  TriggerRef,
} from "@vendoai/core";

/**
 * 01-core §7 — the one mint for this package's "app-lifecycle" audit events
 * (runtime guard/lifecycle reports, interchange export/import, schedule
 * fires). Copies the principal and trigger so a caller's context object never
 * aliases the emitted event.
 */
export const appLifecycleEvent = (
  principal: Principal,
  ctx: Pick<RunContext, "venue" | "presence"> & { trigger?: TriggerRef },
  appId: AppId,
  detail: Record<string, Json>,
  outcome: AuditEvent["outcome"] = "ok",
): AuditEvent => ({
  id: `aud_${globalThis.crypto.randomUUID()}`,
  at: new Date().toISOString(),
  kind: "app-lifecycle",
  principal: { ...principal },
  venue: ctx.venue,
  presence: ctx.presence,
  appId,
  ...(ctx.trigger === undefined ? {} : { trigger: { ...ctx.trigger } }),
  outcome,
  detail,
});
