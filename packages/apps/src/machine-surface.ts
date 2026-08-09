/**
 * execution-v2 — the machine doors (`AppsRuntime.machine`), §9.8's served proxy
 * door, and the box door the fn seam rides.
 *
 * Lifted out of `createApps` unchanged.
 */
import { VendoError } from "@vendoai/core";
import { documentFromRecord } from "./persistence.js";
import { collectSecretValues, redactSecretJson } from "./redaction.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import type { AppsRuntime } from "./types.js";

/** The machine slice of `AppsRuntime`. */
export const createMachineSurface = (
  deps: Pick<AppsRuntimeContext,
    "lifecycle" | "manifestTriggers" | "requireOwned" | "ensureEgressApproved">,
): AppsRuntime["machine"] => {
  const { lifecycle, manifestTriggers, requireOwned, ensureEgressApproved } = deps;
  return {
    available: () => lifecycle.available(),
    async ping(appId, ctx) {
      const app = await requireOwned(appId, ctx, "viewer");
      if (app.machine === undefined) {
        throw new VendoError("validation", `app ${appId} has no machine to ping`);
      }
      const wasAwake = lifecycle.peek(appId) !== undefined;
      // A ping that has to WAKE rides the same egress gate every other wake
      // does: an unapproved declared domain must never reach the provider.
      if (!wasAwake) await ensureEgressApproved(app, ctx);
      const machine = await lifecycle.wake(app);
      // The activity signal itself: one cheap HEAD through the idle-tracked
      // wrapper. Best-effort — a failed HEAD must not fail the keepalive
      // (the wake above already proved the machine is reachable).
      await machine.request({ method: "HEAD", path: "/" }).catch(() => undefined);
      return { state: wasAwake ? "awake" as const : "woke" as const };
    },
    report: () => manifestTriggers.report(),
  };
};

/** §9.8's served door and the box door, which differ only in the level they
 *  require — the wake, the egress pre-flight and the redaction guard are one
 *  forwarder (`box-lane.ts`). */
export const createServedDoors = (
  deps: Pick<AppsRuntimeContext, "config" | "apps" | "lifecycle" | "requireOwned" | "forwardToBox">,
): Pick<AppsRuntime, "serve" | "box"> => {
  const { config, apps, lifecycle, requireOwned, forwardToBox } = deps;
  return {
    async serve(appId, request, ctx) {
      // §9.8 — LIVE rows, every request. `viewer` is the level because a
      // viewer may see and USE a shared app; a caller who cannot see it stays
      // masked, exactly as every other app door answers them.
      //
      // The BoxRequest is forwarded as given. Keeping the browser's cookies,
      // authorization and host headers off the skin is the WIRE route's job:
      // `servedProxyRoutes` assembles the request from method, path,
      // content-type and body alone. A direct caller of this door — the host's
      // own code — chooses its own headers.
      return await forwardToBox(await requireOwned(appId, ctx, "viewer"), request, ctx);
    },
    box: {
      // v2 only: the fn door rides the machine lifecycle's wake — an
      // un-provisioned app fails loudly here (graduation provisions first);
      // the dying v1 session cache never serves a box request.
      async request(appId, request, ctx) {
        return await forwardToBox(await requireOwned(appId, ctx), request, ctx);
      },

      async redact(appId, value) {
        const record = await apps.get(appId);
        if (record === null) return value;
        // issue #566 — same per-box cache preference as box.request: an
        // injected value redacts without a refetch that could fail.
        const secretValues = await collectSecretValues(
          documentFromRecord(record).secrets,
          config.secrets,
          lifecycle.injectedSecretValues(appId),
        );
        return redactSecretJson(value, secretValues);
      },
    },
  };
};
