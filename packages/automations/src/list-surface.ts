/**
 * 07 §1 — the records this caller holds, and one of them by id.
 *
 * Deployment-wide with an `owner`/`agent` filter, and NO app filter: this
 * package has no app concepts. An app page that wants "my automations" resolves
 * its OWN `automations: string[]` and drops the dead ids, which is the apps
 * layer's job and not this one's.
 */
import type { AutomationRecord, RunContext } from "@vendoai/core";
import type { AutomationRowsAccess } from "./automation-rows.js";
import type { EngineBase } from "./engine-context.js";
import type { AutomationsEngine } from "./index.js";
import { allRecords, parseAutomation } from "./rows.js";
import { AUTOMATIONS } from "./types.js";

export type ListSurfaceDeps = { base: EngineBase; automations: AutomationRowsAccess };

/** The signing key never leaves the engine: `list`/`get` are read by chat
 *  surfaces and the console, and a live HMAC secret in a listing is a secret
 *  that has been published. Only the webhook door reads it, off the stored row. */
const redacted = ({ webhookSecret: _, ...record }: AutomationRecord): AutomationRecord => record;

export const createListSurface = (
  { base: { engine }, automations }: ListSurfaceDeps,
): Pick<AutomationsEngine, "list" | "get"> => {
  const list: AutomationsEngine["list"] = async (filter, ctx) => {
    // Indexed per owner (never a scan): the caller, plus every org the
    // memberships seam asserted for them. An ORG-held record's subject is the
    // org id (§9.5), so the caller's own subject alone would list a promoted
    // automation for nobody at all.
    const subjects = filter.owner === undefined
      ? [ctx.principal.subject, ...(ctx.memberships ?? []).map(({ org }) => org)]
      : [filter.owner];
    const found = new Map<string, AutomationRecord>();
    for (const subject of new Set(subjects)) {
      for (const stored of await allRecords(engine, AUTOMATIONS, { refs: { subject } })) {
        const row = parseAutomation(stored);
        // The ownership check still decides: a filter naming a subject the caller
        // does not speak for answers empty, never someone else's automations.
        if (!automations.speaksFor(ctx, row.owner.subject)) continue;
        if (filter.agent !== undefined && row.agent !== filter.agent) continue;
        found.set(row.id, redacted(row));
      }
    }
    return [...found.values()];
  };

  const get: AutomationsEngine["get"] = async (automationId: string, ctx: RunContext) => {
    const found = await automations.ownedOrNull(automationId, ctx);
    return found === null ? null : redacted(found.row);
  };

  return { list, get };
};
