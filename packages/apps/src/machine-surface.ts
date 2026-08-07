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
    "lifecycle" | "manifestTriggers" | "requireOwned" | "ensureEgressApproved"
    | "requestEgressApproval" | "editServerViaBox" | "reportLifecycle">,
): AppsRuntime["machine"] => {
  const { lifecycle, manifestTriggers, requireOwned, ensureEgressApproved } = deps;
  const { requestEgressApproval, editServerViaBox, reportLifecycle } = deps;
  return {
    available: () => lifecycle.available(),
    async provision(appId, ctx) {
      const app = await requireOwned(appId, ctx);
      const alreadyProvisioned = app.machine !== undefined;
      // `experimentalMachines` used to gate NEW provisioning here with a second
      // error explaining the flag. The flag is gone, and so is that error: with
      // the sandbox adapter as the whole gate, "there is nothing to provision
      // in" is exactly what the lifecycle's own `sandbox-unavailable` already
      // says, and the escalation ladder never reaches this line — `laneGates`
      // states the missing lane to the brain BEFORE it plans. An
      // already-provisioned app stays idempotent, so it is never stranded.
      // Lane E — first provision is the "approve once" moment: unapproved
      // declared egress parks the approval card and refuses loudly here.
      await ensureEgressApproved(app, ctx);
      const provisioned = await lifecycle.provision(app);
      if (!alreadyProvisioned) await reportLifecycle("machine-provision", appId, ctx);
      return provisioned;
    },
    async wake(appId, ctx) {
      const app = await requireOwned(appId, ctx);
      // Lane E — a manifest change adding domains re-prompts at the next
      // wake: the new declaration parks a fresh card for the delta only.
      await ensureEgressApproved(app, ctx);
      return lifecycle.wake(app);
    },
    async sleep(appId, ctx) {
      const app = await requireOwned(appId, ctx);
      return lifecycle.sleep(app);
    },
    async editApp(appId, instruction, ctx) {
      const app = await requireOwned(appId, ctx);
      if (app.machine === undefined) {
        throw new VendoError("validation", `app ${appId} has not graduated; use edit to graduate it first`);
      }
      // A pre-declared unapproved egress must clear (or park) before we wake
      // the box — the wake would refuse it anyway (Lane E boxAllowlist).
      await ensureEgressApproved(app, ctx);
      const outcome = await editServerViaBox(app, instruction, ctx);
      if (!outcome.ok) {
        return { ok: false, summary: outcome.result.summary, filesChanged: outcome.result.filesChanged };
      }
      const pending = await requestEgressApproval(outcome.doc, ctx);
      return {
        ok: true,
        summary: outcome.result.summary,
        ...(outcome.result.fns === undefined ? {} : { fns: outcome.result.fns }),
        filesChanged: outcome.result.filesChanged,
        app: outcome.doc,
        ...(pending.status === "pending" ? { pendingEgress: { approvalId: pending.approvalId, domains: pending.domains } } : {}),
      };
    },
    async ping(appId, ctx) {
      const app = await requireOwned(appId, ctx, "viewer");
      if (app.machine === undefined) {
        throw new VendoError("validation", `app ${appId} has no machine to ping`);
      }
      const wasAwake = lifecycle.peek(appId) !== undefined;
      // A ping that has to WAKE rides the same egress gate as machine.wake:
      // an unapproved declared domain must never reach the provider.
      if (!wasAwake) await ensureEgressApproved(app, ctx);
      const machine = await lifecycle.wake(app);
      // The activity signal itself: one cheap HEAD through the idle-tracked
      // wrapper. Best-effort — a failed HEAD must not fail the keepalive
      // (the wake above already proved the machine is reachable).
      await machine.request({ method: "HEAD", path: "/" }).catch(() => undefined);
      return { state: wasAwake ? "awake" as const : "woke" as const };
    },
    async destroy(appId, ctx) {
      const app = await requireOwned(appId, ctx, "owner");
      const cleared = await lifecycle.destroyMachine(app);
      // De-graduation retires the old scheduler's leftover row with the machine.
      await manifestTriggers.clearLegacyState(appId);
      if (app.machine !== undefined) await reportLifecycle("machine-destroy", appId, ctx);
      return cleared;
    },
    async syncManifest(appId, ctx) {
      const app = await requireOwned(appId, ctx);
      return manifestTriggers.sync(app, ctx);
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
