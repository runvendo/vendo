/**
 * ENG-345 — `AppsRuntime.secrets`: which of an app's declared secrets are live
 * inside its box, and the owner-only, high-risk door that turns one on.
 *
 * Lifted out of `createApps` unchanged.
 */
import { VendoError, type ApprovalId, type RunContext } from "@vendoai/core";
import type { AppsRuntimeContext } from "./runtime-context.js";
import type { AppsRuntime } from "./types.js";

/** The secrets slice of `AppsRuntime`. */
export const createSecretsSurface = (
  deps: Pick<AppsRuntimeContext,
    "config" | "exposure" | "requireOwned" | "markMachineEnvStale"
    | "exposureCall" | "exposureDescriptor" | "reportGuard">,
): AppsRuntime["secrets"] => {
  const { config, exposure, requireOwned, markMachineEnvStale } = deps;
  const { exposureCall, exposureDescriptor, reportGuard } = deps;
  return {
    async exposure(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner"); // which secrets are live is owner-only
      const grants = new Map((await exposure.list(appId)).map((grant) => [grant.secretName, grant]));
      return (app.secrets ?? []).map((secretName) => {
        const grant = grants.get(secretName);
        if (grant === undefined) return { secretName, status: "handle" as const };
        return grant.status === "active"
          ? { secretName, status: "exposed" as const }
          : { secretName, status: "pending" as const, approvalId: grant.approvalId };
      });
    },

    async setExposure(input, ctx) {
      // Owner-only: exposing a real secret value is the highest-risk
      // write an app has; a shared editor never reaches it (§9.3).
      const app = await requireOwned(input.appId, ctx, "owner");
      if (!(app.secrets ?? []).includes(input.secretName)) {
        throw new VendoError("validation", `secret not declared by app: ${input.secretName}`);
      }

      if (input.expose === false) {
        // Turning OFF is safe — revert to the Option B handle default at once.
        await exposure.revoke(input.appId, input.secretName);
        // Wave 7 — the revoked value is still baked into the box snapshot;
        // the stale marker makes the next wake rebuild env without it.
        await markMachineEnvStale(input.appId);
        await reportGuard(ctx.principal.subject, input.appId, ctx, {
          operation: "secret-exposure-set",
          secretName: input.secretName,
          expose: false,
        });
        return { status: "handles" };
      }

      // Turning ON is HIGH-RISK: route through the guard's existing confirmEach
      // approval flow. appId is pinned in the guard ctx so the parked approval
      // is app-scoped (and, for the real guard, so an approved replay matches).
      const guardCtx: RunContext = { ...ctx, appId: input.appId };
      const decision = await config.guard.check(
        exposureCall(input.appId, input.secretName),
        exposureDescriptor(),
        guardCtx,
      );
      if (decision.action === "block") {
        throw new VendoError("blocked", decision.reason);
      }
      if (decision.action === "run") {
        // A pre-approved replay already cleared the high-risk gate — commit now.
        const approvalId: ApprovalId = decision.grantId === undefined
          ? `apr_replayed_${globalThis.crypto.randomUUID()}`
          : `apr_${decision.grantId}`;
        await exposure.putPending({
          appId: input.appId,
          secretName: input.secretName,
          owner: ctx.principal.subject,
          approvalId,
          requestedAt: new Date().toISOString(),
        });
        await exposure.activate(input.appId, input.secretName);
        // Wave 7 — same stale marker as the approval-decided commit path.
        await markMachineEnvStale(input.appId);
        await reportGuard(ctx.principal.subject, input.appId, ctx, {
          operation: "secret-exposure-set",
          secretName: input.secretName,
          expose: true,
        });
        return { status: "exposed" };
      }
      // Parked: record the pending grant against this approval; it flips to
      // active only when onApprovalDecision fires with approved=true.
      await exposure.putPending({
        appId: input.appId,
        secretName: input.secretName,
        owner: ctx.principal.subject,
        approvalId: decision.approval.id,
        requestedAt: new Date().toISOString(),
      });
      return { status: "pending-approval", approvalId: decision.approval.id };
    },
  };
};
