/**
 * The engine's INTERNAL write surface: the one create operation, and the one
 * place a reconcile plan is applied.
 *
 * INVARIANT: exactly one create exists, and all four authoring doors go through
 * it — the `vendo_automate` chat tool, `vendo_make`'s auto-arm sugar, the
 * `vendo.json` manifest fold-in, and `agent.on`'s boot reconcile. Neither door
 * here is public API: both hang off `automationsInternals(engine)`, so
 * `vendo.automations` cannot reach them and a host cannot mint an automation for
 * somebody else.
 *
 * A second create path is the failure this file exists to prevent. Four doors
 * that each wrote their own record would each decide, differently, what a
 * webhook secret is, when an id is minted, and whether a redeploy replaces or
 * conflicts — and the disagreements would only show up in production.
 */
import {
  declaredAutomationId,
  toTriggerSource,
  VendoError,
  type AutomationId,
  type AutomationRecord,
  type CreateAutomation,
  type ReconcilePlan,
  type RunContext,
} from "@vendoai/core";
import type { AutomationRowsAccess } from "./automation-rows.js";
import type { EngineBase } from "./engine-context.js";
import { id } from "./rows.js";
import { SCHEDULE } from "./types.js";
import { base64url } from "./webhook-signature.js";

export type CreateSurfaceDeps = { base: EngineBase; automations: AutomationRowsAccess };

/** Applying a {@link ReconcilePlan}: the records it says to create, and the ones
 *  it says to disarm. Returns what it actually touched, so a boot can log it. */
export type ReconcileAutomations = (
  plan: ReconcilePlan,
  ctx: RunContext,
) => Promise<{ created: AutomationRecord[]; disarmed: AutomationId[] }>;

export interface CreateSurfaceAccess {
  create: CreateAutomation;
  reconcile: ReconcileAutomations;
}

export const createCreateSurface = (
  { base: { engine, iso }, automations }: CreateSurfaceDeps,
): CreateSurfaceAccess => {
  const create: CreateAutomation = async (input, ctx) => {
    // A door may only mint for a principal it speaks for. Every caller resolves
    // the owner from a real request or from the deployment's own boot identity,
    // so this is not defensive — it is the one thing standing between a chat
    // tool and an automation that runs as somebody else.
    if (!automations.speaksFor(ctx, input.owner.subject)) {
      throw new VendoError("forbidden", `cannot create an automation owned by ${input.owner.subject}`);
    }
    const when = toTriggerSource(input.when);
    // A declared id REPLACES: a redeploy re-running create with a stored id is
    // the normal case, not a conflict. Absent, the id is minted — a chat-authored
    // record has no stable identity to reconcile against and does not want one.
    const automationId = input.id ?? (
      input.authoredBy === "chat" ? id("atm_") : declaredAutomationId(input, when)
    );
    const existing = await automations.automationRecord(automationId);
    const now = iso();
    const record: AutomationRecord = {
      id: automationId,
      owner: input.owner,
      when,
      task: input.task,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      armed: input.armed ?? true,
      authoredBy: input.authoredBy,
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      // The signing key is minted ONCE and survives every replace: rotating it
      // on a redeploy would silently break every sender already pointed at the
      // door.
      ...(when.kind !== "external" ? {} : {
        webhookSecret: existing?.row.webhookSecret
          ?? base64url(globalThis.crypto.getRandomValues(new Uint8Array(32))),
      }),
      createdAt: existing?.row.createdAt ?? now,
      updatedAt: now,
    };
    await automations.write(record);
    // A schedule's cursor starts NOW, so a record created at 3pm with a 9am cron
    // fires tomorrow morning rather than immediately claiming a run for a 9am
    // that already passed. `insertIfAbsent`, so a replace leaves an existing
    // cursor — and its firing history — exactly where it was.
    if (when.kind === "schedule") {
      await engine.insertIfAbsent(SCHEDULE, {
        id: automationId,
        data: { lastFiredAt: now },
        refs: { automation_id: automationId },
      });
    }
    return record;
  };

  /**
   * Apply a plan `reconcileAutomations` produced. ONE caller: the umbrella's
   * boot, after collecting `.on()` declarations and the manifest fold-in.
   *
   * The disarm here is deliberately NOT `automations.disable`. The public kill
   * switch stamps `disarmedBy: "user"`, and a redeploy stamping that would be a
   * machine impersonating a person — the next deploy could then clear a switch a
   * human set, which is exactly the invariant "the manual kill switch survives
   * every redeploy" exists to prevent. Consent for a code-authored automation
   * WAS the code; the code no longer says it, so the record is disarmed and
   * nothing more is claimed about who decided.
   *
   * Two disarm reasons, one `armed` flag: the stamp's presence or absence IS the
   * distinction, so there is no second flag and no state machine to keep in step.
   *
   * A record a person disarmed is skipped on BOTH sides — never re-created, never
   * disarmed again. `reconcileAutomations` already filters it out of the plan;
   * this re-checks at write time because the plan was computed against a read
   * that a person may have raced.
   */
  const reconcile: ReconcileAutomations = async (plan, ctx) => {
    const created: AutomationRecord[] = [];
    for (const input of plan.create) {
      const existing = input.id === undefined ? null : await automations.automationRecord(input.id);
      if (existing?.row.disarmedBy === "user") continue;
      created.push(await create(input, ctx));
    }
    const disarmed: AutomationId[] = [];
    for (const automationId of plan.disarm) {
      const found = await automations.automationRecord(automationId);
      if (found === null || found.row.disarmedBy === "user" || !found.row.armed) continue;
      await automations.write({ ...found.row, armed: false, updatedAt: iso() });
      disarmed.push(automationId);
    }
    return { created, disarmed };
  };

  return { create, reconcile };
};
