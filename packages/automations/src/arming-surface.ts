/**
 * 07 §3 — the ceremonies a person performs while they are PRESENT: arming (which
 * names the sponsor and captures the grants), the kill switch, and the preview
 * that says what a record would run without running it.
 */
import { VendoError, type Json } from "@vendoai/core";
import type { AutomationRowsAccess } from "./automation-rows.js";
import type { ConsentAccess } from "./consent.js";
import type { EngineBase } from "./engine-context.js";
import type { GrantsAccess } from "./grants.js";
import type { AutomationsEngine, RunPlan } from "./index.js";
import { currentIntentHash, declaredSurface, markSponsored, writeSponsorship } from "./sponsorship.js";
import { evaluate, stepArgs, validateForEachItems } from "./steps.js";

export type ArmingSurfaceDeps = {
  base: EngineBase;
  automations: AutomationRowsAccess;
  grants: GrantsAccess;
  consent: ConsentAccess;
};

/** 07 §3's arm/disarm pair. */
const createArmDoors = (deps: ArmingSurfaceDeps): Pick<AutomationsEngine, "enable" | "disable"> => {
  const { base: { engine, iso }, automations, grants, consent } = deps;
  const enable: AutomationsEngine["enable"] = async (automationId, ctx) => {
    const found = await automations.owned(automationId, ctx);
    const { missing, grantSetId } = await consent.captureGrants(
      found.row,
      await grants.descriptors(ctx),
      ctx,
    );
    // §9.9 — enabling is what names the sponsor: the person arming an automation
    // is the person it runs as, bound to the intent they just saw. A re-enable
    // refreshes both, which is how an invalidated automation comes back.
    await writeSponsorship(engine, {
      automationId,
      sponsor: ctx.principal.subject,
      ...(ctx.principal.display === undefined ? {} : { display: ctx.principal.display }),
      intentHash: currentIntentHash(found.row),
      status: "active",
    });
    // The era marker outlives an erase of the sponsor, so a vanished row can
    // never be misread as "never sponsored" (§9.9 fails closed).
    await markSponsored(engine, automationId, iso());
    // Re-arming clears the manual kill switch: the person turning it back on is
    // the same authority that turned it off, and a record that stayed flagged
    // would be skipped by every reconcile forever.
    const { disarmedBy: _cleared, ...rest } = found.row;
    // The set is stamped on the RECORD because that is where a consent surface
    // holding only the automation id reads it from — chrome resolves the record
    // through `list()` and settles the whole set with the id it finds there.
    await automations.write({
      ...rest,
      armed: true,
      ...(missing.length === 0 ? {} : { grantSetId }),
      updatedAt: iso(),
    });
    return { enabled: true, missing, ...(missing.length === 0 ? {} : { grantSetId }) };
  };

  /** The kill switch. `disarmedBy: "user"` is what makes it SURVIVE a redeploy:
   *  a code reconcile leaves a record carrying it entirely alone, so re-running
   *  `agent.on` never quietly turns back on something a person switched off. */
  const disable: AutomationsEngine["disable"] = async (automationId, ctx) => {
    const found = await automations.owned(automationId, ctx);
    await automations.write({ ...found.row, armed: false, disarmedBy: "user", updatedAt: iso() });
  };

  return { enable, disable };
};

/** Preview: what a record would run, nothing executes. */
const createDryRunDoor = (
  deps: Pick<ArmingSurfaceDeps, "automations" | "grants">,
): Pick<AutomationsEngine, "dryRun"> => {
  const { automations, grants } = deps;
  const dryRun: AutomationsEngine["dryRun"] = async (automationId, ctx, event) => {
    const found = await automations.owned(automationId, ctx);
    const byName = await grants.descriptors(ctx);
    const plan: RunPlan = { steps: [], grantsMissing: [] };
    // The record's HOST tools, from the one place that rule lives: `declaredSurface`
    // is every step tool EXCEPT the `fn:` refs, so a steps record naming a tool
    // absent from it is naming the app's own server code. Listed — a preview says
    // what would run — but never resolved against the host registry and never a
    // missing grant. An unknown HOST tool IS in that set, so it still fails loudly.
    const hostTools = new Set(declaredSurface(found.row));
    const add = async (stepId: string, tool: string): Promise<void> => {
      if (found.row.task.kind === "steps" && !hostTools.has(tool)) {
        plan.steps.push({ id: stepId, tool, wouldAsk: false });
        return;
      }
      const descriptor = byName.get(tool);
      if (descriptor === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      const granted = await grants.liveGrant(found.row.owner.subject, automationId, descriptor);
      plan.steps.push({ id: stepId, tool, wouldAsk: descriptor.confirmEach === true || !granted });
      if (!descriptor.confirmEach && !granted && !plan.grantsMissing.includes(tool)) plan.grantsMissing.push(tool);
    };
    if (found.row.task.kind === "goal") {
      for (const descriptor of byName.values()) await add(descriptor.name, descriptor.name);
      return plan;
    }
    const outputs: Record<string, Json> = {};
    for (const step of found.row.task.steps) {
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
