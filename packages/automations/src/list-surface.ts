/**
 * 07 §1 — the user's apps that have triggers, each with its trigger LIST: what
 * is armed, who it runs as, whether it stopped, and what it is still waiting to
 * be allowed.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import type { AppRowsAccess } from "./app-rows.js";
import type { ArmedAccess } from "./armed.js";
import type { ConsentAccess } from "./consent.js";
import type { EngineBase } from "./engine-context.js";
import type { AutomationsEngine } from "./index.js";
import { stopFor } from "./messages.js";
import { allRecords, parseAppRow } from "./rows.js";
import type { SponsorshipGateAccess } from "./sponsorship-gate.js";
import { sponsorshipSchema, triggerKey, triggersOf } from "./sponsorship.js";
import { APPS } from "./types.js";

export type ListSurfaceDeps = {
  base: EngineBase;
  appRows: AppRowsAccess;
  armed: ArmedAccess;
  sponsorship: SponsorshipGateAccess;
  consent: ConsentAccess;
};

export const createListSurface = (deps: ListSurfaceDeps): Pick<AutomationsEngine, "list"> => {
  const { base: { config }, appRows, armed } = deps;
  const { sponsorship, consent } = deps;

  const list: AutomationsEngine["list"] = async (ctx) => {
    const subject = ctx.principal.subject;
    const records = await allRecords(config.store.records(APPS), { refs: { subject } });
    const rows = records.map(parseAppRow).filter((row) => row.subject === subject);
    const seen = new Set(rows.map((row) => row.doc.id));
    // An ORG-held app's row subject is the org id (§9.5), so matching only the
    // caller's own subject listed a promoted automation for NOBODY — not the
    // members, not the org admin, not the person who promoted it — while promote
    // tells that person it "stays off until someone turns it back on". The orgs
    // come from the ctx (§9.1: asserted, never stored) and `can(editor)` still
    // decides each row.
    for (const org of new Set((ctx.memberships ?? []).map(({ org: id }) => id))) {
      for (const record of await allRecords(config.store.records(APPS), { refs: { subject: org } })) {
        const row = parseAppRow(record);
        if (row.subject !== org || seen.has(row.doc.id)) continue;
        if (await appRows.canEdit(ctx, row, row.doc.id)) {
          seen.add(row.doc.id);
          rows.push(row);
        }
      }
    }
    // An automation runs as its SPONSOR, who may not own the app — and the
    // person it runs as has to be able to see it (§8: editor = edit). The
    // sponsorship rows are ref'd by subject, so this is one indexed query, never
    // a scan of everybody's apps.
    //
    // INVALIDATED rows are included on purpose: a stopped automation
    // must not vanish from here, or there is no way back to it at all.
    // Deduped: sponsorship is per (app, trigger), so sponsoring two triggers of
    // one app must still fetch that app once.
    const sponsoredElsewhere = [...new Set(
      (await allRecords(sponsorship.sponsorships(), { refs: { subject } }))
        .map((record) => sponsorshipSchema.safeParse(record.data))
        .flatMap((parsed) => parsed.success ? [parsed.data.appId] : [])
        .filter((appId) => !seen.has(appId)),
    )];
    for (const record of sponsoredElsewhere.length === 0
      ? []
      : await allRecords(config.store.records(APPS), { ids: sponsoredElsewhere })) {
      const row = parseAppRow(record);
      // Sponsoring is not access: an editor whose grant was revoked keeps the
      // row but loses the door, so `can(editor)` still decides.
      if (await appRows.canEdit(ctx, row, row.doc.id)) rows.push(row);
    }
    // Pending-captures projection: an armed trigger with outstanding standing-grant
    // asks is NOT plain enabled — surfaces render "waiting on N permissions"
    // from here (reload-safe; never from an enable() result held in memory).
    // Keyed per (app, trigger), because that is the unit a person allowed.
    const outstanding = new Map<string, { pendingGrants: number; grantSetId?: string }>();
    for (const capture of await consent.pendingCaptures(subject)) {
      const key = triggerKey(capture.data.appId, capture.data.triggerId);
      const entry = outstanding.get(key) ?? { pendingGrants: 0 };
      entry.pendingGrants += 1;
      entry.grantSetId ??= capture.data.grantSetId;
      outstanding.set(key, entry);
    }
    const automations = rows.filter((row) => triggersOf(row.doc).length > 0);
    const sponsorRows = await sponsorship.sponsorshipsFor(automations);
    const armedKeys = await armed.armedFor(automations);
    const entries: Awaited<ReturnType<AutomationsEngine["list"]>> = [];
    for (const row of automations) {
      // "…and names a wider editor set when one exists": the count comes from
      // the grants themselves, so a deployment with no access seam says nothing
      // rather than implying the automation is private. Per APP: app access is
      // not a per-trigger fact.
      const editors = config.appAccess?.list === undefined
        ? undefined
        : (await config.appAccess.list(ctx, row.doc.id)).length;
      const armedHere = new Set(armed.armedTriggers(row, armedKeys).map((trigger) => trigger.id));
      entries.push({
        app: row.doc,
        triggers: triggersOf(row.doc).map((trigger) => {
          const key = triggerKey(row.doc.id, trigger.id);
          const pending = outstanding.get(key);
          // §13's window label — "runs with Dana's access". The name rides the
          // sponsorship row (captured from their own Principal when they took the
          // automation on), so it reads the same for everyone; Vendo still holds no
          // directory and invents no name for anybody.
          const sponsorRow = sponsorRows.get(key);
          const sponsor = sponsorRow?.sponsor ?? row.subject;
          const display = sponsorRow?.display ?? (sponsor === subject ? ctx.principal.display : undefined);
          // A stopped automation says so HERE, in the same sentence the
          // stopped run row uses, so the list is a way back to it rather than a
          // place it silently disappeared from.
          const stopped = sponsorRow?.status === "invalidated"
            ? stopFor(sponsorRow.reason ?? "edit", row.doc.name)
            : undefined;
          return {
            trigger,
            enabled: armedHere.has(trigger.id),
            sponsor: { subject: sponsor, ...(display === undefined ? {} : { display }) },
            ...(stopped === undefined ? {} : { stopped }),
            ...(pending === undefined ? {} : {
              pendingGrants: pending.pendingGrants,
              ...(pending.grantSetId === undefined ? {} : { grantSetId: pending.grantSetId }),
            }),
          };
        }),
        ...(editors === undefined ? {} : { editors }),
      });
    }
    return entries;
  };

  return { list };
};
