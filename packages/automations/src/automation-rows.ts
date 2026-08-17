/**
 * The `vendo_automations` row, as this engine reads and writes it: the one
 * ownership gate every door goes through, and the per-kind queries the tick,
 * emit and webhook fire from.
 *
 * There is exactly one authority question about a record — is the caller its
 * owner, or a member of the org that owns it — because a record has no app for
 * an access seam to be asked about.
 */
import {
  VendoError,
  type AutomationRecord,
  type RunContext,
  type TriggerSource,
  type VendoRecord,
} from "@vendoai/core";
import type { EngineBase } from "./engine-context.js";
import { allRecords, parseAutomation } from "./rows.js";
import { AUTOMATIONS } from "./types.js";

export type AutomationRowsDeps = { base: EngineBase };

export interface AutomationRowsAccess {
  /** The record and the store row it came from, or null when there is none. */
  automationRecord(id: string): Promise<{ record: VendoRecord; row: AutomationRecord } | null>;
  /** The record, for a caller allowed to change it — null when absent OR refused. */
  ownedOrNull(id: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AutomationRecord } | null>;
  /** The same door, existence-masked, for callers that must refuse. */
  owned(id: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AutomationRecord }>;
  /** Whether this caller speaks for that owner subject: it is their own, or an
   *  org the memberships seam asserted for them. */
  speaksFor(ctx: RunContext, subject: string): boolean;
  /** The write, with the refs every read path is indexed by. */
  write(row: AutomationRecord): Promise<void>;
  /** The armed records that fire on this trigger kind, by its per-kind ref. */
  firingOn(kind: TriggerSource["kind"], refs?: Record<string, string>): Promise<AutomationRecord[]>;
}

/** Every subject this ctx speaks for: itself, and each org the host's
 *  memberships seam asserted for it (§9.1 — asserted per call, never stored). */
const subjectsOf = (ctx: RunContext): Set<string> =>
  new Set([ctx.principal.subject, ...(ctx.memberships ?? []).map(({ org }) => org)]);

export const createAutomationRows = ({ base: { engine } }: AutomationRowsDeps): AutomationRowsAccess => {
  const automationRecord = async (
    id: string,
  ): Promise<{ record: VendoRecord; row: AutomationRecord } | null> => {
    const record = await engine.get(AUTOMATIONS, id);
    return record === null ? null : { record, row: parseAutomation(record) };
  };

  /** An ORG-held record's owner subject is the org id (§9.5), and no principal
   *  is ever an org (§9.1 keeps `kind:"org"` refused at the wire) — so matching
   *  the caller's own subject alone would make an org-owned automation
   *  unreachable by everybody, including whoever created it. */
  const speaksFor = (ctx: RunContext, subject: string): boolean => subjectsOf(ctx).has(subject);

  const ownedOrNull = async (
    id: string,
    ctx: RunContext,
  ): Promise<{ record: VendoRecord; row: AutomationRecord } | null> => {
    const found = await automationRecord(id);
    return found === null || !speaksFor(ctx, found.row.owner.subject) ? null : found;
  };

  /** Existence-masking: someone who does not hold the record hears "not found",
   *  not "no". */
  const owned = async (
    id: string,
    ctx: RunContext,
  ): Promise<{ record: VendoRecord; row: AutomationRecord }> => {
    const found = await ownedOrNull(id, ctx);
    if (found === null) throw new VendoError("not-found", `automation not found: ${id}`);
    return found;
  };

  /** The refs are what keep the tick and `emit` indexed rather than scanning
   *  every record for every firing. ONE kind key, not a set: a record has
   *  exactly one trigger, which is the whole difference from the app-with-a-list
   *  shape this replaces. */
  const write = async (row: AutomationRecord): Promise<void> => {
    await engine.put(AUTOMATIONS, {
      id: row.id,
      data: row,
      refs: { subject: row.owner.subject, when_kind: row.when.kind },
    });
  };

  const firingOn = async (
    kind: TriggerSource["kind"],
    refs: Record<string, string> = {},
  ): Promise<AutomationRecord[]> =>
    (await allRecords(engine, AUTOMATIONS, { refs: { ...refs, when_kind: kind } }))
      .map(parseAutomation)
      .filter((row) => row.armed);

  return { automationRecord, ownedOrNull, owned, speaksFor, write, firingOn };
};
