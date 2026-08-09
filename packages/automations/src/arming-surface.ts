/**
 * 07 §3 — the per-trigger ceremonies a person performs while they are PRESENT:
 * arming (which names the sponsor and captures the grants), disarming, and the
 * preview that says what the trigger would run without running it.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import { VendoError, type Json } from "@vendoai/core";
import type { AutomationsEngineContext } from "./engine-context.js";
import type { AutomationsEngine, RunPlan } from "./index.js";
import { appRef } from "./rows.js";
import { currentIntentHash, markSponsored, triggerKey, writeSponsorship } from "./sponsorship.js";
import { evaluate, stepArgs, validateForEachItems } from "./steps.js";
import { SCHEDULE, WEBHOOK } from "./types.js";
import { base64url } from "./webhook-signature.js";

export type ArmingSurfaceDeps = Pick<
  AutomationsEngineContext,
  | "config"
  | "iso"
  | "firesLocally"
  | "editableApp"
  | "declaredTrigger"
  | "writeApp"
  | "setArmed"
  | "disarmTrigger"
  | "descriptors"
  | "liveGrant"
  | "captureGrants"
  | "sponsorships"
  | "sponsoredEra"
>;

/** 07 §3's arm/disarm pair. */
const createArmDoors = (
  deps: Pick<
    ArmingSurfaceDeps,
    "config" | "iso" | "firesLocally" | "editableApp" | "declaredTrigger" | "writeApp"
    | "setArmed" | "disarmTrigger" | "descriptors" | "captureGrants" | "sponsorships" | "sponsoredEra"
  >,
): Pick<AutomationsEngine, "enable" | "disable"> => {
  const { config, iso, firesLocally, editableApp, declaredTrigger, writeApp } = deps;
  const { setArmed, disarmTrigger, descriptors, captureGrants, sponsorships, sponsoredEra } = deps;
  const enable: AutomationsEngine["enable"] = async (appId, triggerId, ctx) => {
    const found = await editableApp(appId, ctx);
    const trigger = declaredTrigger(found.row.doc, triggerId);
    // fn: steps run in the APP's own sandbox machine (packages/apps/src/fn.ts
    // POSTs /fn/<name> to it), not in this process — so when some other
    // authority fires this trigger, that authority is the one that has to wake
    // and reach the machine, and in v1 it may not be able to. Arming is the
    // only point that sees both the trigger kind and the steps.
    if (trigger.on.kind !== "host-event" && !firesLocally(trigger.on.kind)
      && trigger.run.kind === "steps"
      && trigger.run.steps.some((step) => step.tool.startsWith("fn:"))) {
      console.warn(
        `[vendo] automation "${found.row.doc.name}" has fn: steps but its ${trigger.on.kind} trigger fires on Vendo Cloud, `
        + "not in this process: fn: steps run in the app's own sandbox machine, which the Cloud runner may not be able to "
        + "wake or reach in v1 (those steps then settle as an error outcome). Replace them with host tools, or pass an "
        + "explicit local `store:` to createVendo to keep this composition firing its own schedule and external triggers.",
      );
    }
    const { missing, grantSetId } = await captureGrants(
      found.row.doc,
      trigger,
      await descriptors(ctx),
      ctx,
    );
    // §9.9 — enabling is what names the sponsor: the person arming an
    // automation is the person it runs as, bound to the intent they just saw.
    // A re-enable refreshes both, which is how an invalidated automation comes
    // back. Per TRIGGER, because that is the thing they just looked at and
    // allowed.
    await writeSponsorship(sponsorships(), {
      appId,
      triggerId: trigger.id,
      sponsor: ctx.principal.subject,
      ...(ctx.principal.display === undefined ? {} : { display: ctx.principal.display }),
      intentHash: currentIntentHash(found.row.doc, trigger),
      status: "active",
    });
    // The era marker outlives an erase of the sponsor, so a vanished row can
    // never be misread as "never sponsored" (§9.9 fails closed).
    await markSponsored(sponsoredEra(), appId, trigger.id, iso());
    await setArmed(appId, trigger.id, true);
    found.row.enabled = true;
    await writeApp(found.record, found.row);
    const key = triggerKey(appId, trigger.id);
    if (trigger.on.kind === "schedule") {
      const cursor = await config.store.records(SCHEDULE).get(key);
      if (cursor === null) {
        await config.store.records(SCHEDULE).put({ id: key, data: { lastFiredAt: iso() }, refs: appRef(appId) });
      }
    }
    if (trigger.on.kind === "external") {
      const secret = await config.store.records(WEBHOOK).get(key);
      if (secret === null) {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
        await config.store.records(WEBHOOK).put({ id: key, data: { secret: base64url(bytes) }, refs: appRef(appId) });
      }
    }
    return { enabled: true, missing, ...(missing.length === 0 ? {} : { grantSetId }) };
  };

  const disable: AutomationsEngine["disable"] = async (appId, triggerId, ctx) => {
    const found = await editableApp(appId, ctx);
    await disarmTrigger(found.record, found.row, triggerId);
  };

  return { enable, disable };
};

/** Preview: what ONE trigger would run, nothing executes. */
const createDryRunDoor = (
  deps: Pick<ArmingSurfaceDeps, "editableApp" | "declaredTrigger" | "descriptors" | "liveGrant">,
): Pick<AutomationsEngine, "dryRun"> => {
  const { editableApp, declaredTrigger, descriptors, liveGrant } = deps;
  const dryRun: AutomationsEngine["dryRun"] = async (appId, triggerId, ctx, event) => {
    const found = await editableApp(appId, ctx);
    const trigger = declaredTrigger(found.row.doc, triggerId);
    const byName = await descriptors(ctx);
    const plan: RunPlan = { steps: [], grantsMissing: [] };
    const add = async (stepId: string, tool: string): Promise<void> => {
      if (tool.startsWith("fn:")) {
        plan.steps.push({ id: stepId, tool, wouldAsk: false });
        return;
      }
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      const granted = await liveGrant(found.row.subject, appId, triggerId, descriptor);
      plan.steps.push({ id: stepId, tool, wouldAsk: descriptor.confirmEach === true || !granted });
      if (!descriptor.confirmEach && !granted && !plan.grantsMissing.includes(tool)) plan.grantsMissing.push(tool);
    };
    if (trigger.run.kind === "agentic") {
      for (const descriptor of byName.values()) await add(descriptor.name, descriptor.name);
      return plan;
    }
    const outputs: Record<string, Json> = {};
    for (const step of trigger.run.steps) {
      if (event === undefined) {
        await add(step.id, step.tool);
        continue;
      }
      try {
        if (step.if !== undefined && !await evaluate(step.if, { event, steps: outputs, item: undefined })) continue;
        if (step.forEach === undefined) {
          await stepArgs(step, event, outputs);
          await add(step.id, step.tool);
          continue;
        }
        const items = validateForEachItems(
          step,
          await evaluate(step.forEach, { event, steps: outputs, item: undefined }),
        );
        for (const item of items) {
          await stepArgs(step, event, outputs, item);
          await add(step.id, step.tool);
        }
      } catch {
        // Nothing executes in a dry run, so `steps.<id>` outputs stay empty —
        // expressions over them cannot expand. Degrade to the static entry
        // rather than failing the preview.
        await add(step.id, step.tool);
      }
    }
    return plan;
  };

  return { dryRun };
};

export const createArmingSurface = (
  deps: ArmingSurfaceDeps,
): Pick<AutomationsEngine, "enable" | "disable" | "dryRun"> =>
  ({ ...createArmDoors(deps), ...createDryRunDoor(deps) });
