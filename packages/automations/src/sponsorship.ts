import {
  canonicalJson,
  DEFAULT_TRIGGER_ID,
  intentHash,
  type AppDocument,
  type AppIntent,
  type IsoDateTime,
  type Json,
  type RecordStore,
  type Trigger,
} from "@vendoai/core";
import { z } from "zod";

/** Build contract §9.9 — sponsorship lives in its OWN routed collection, never
 *  on the app row: the row is the automation's declaration, this is who it runs
 *  as, and two independent facts on one row drift. Engine-internal state like
 *  `automations:captures`, so the generic records door is right here. */
export const SPONSORSHIPS = "automations:sponsorships";

/** The era marker: "this app has been sponsored at least once", keyed to the app
 *  and carrying NO subject data at all.
 *
 *  It exists because the sponsorship row itself must be erasable: it holds a
 *  person's subject, so `eraseStore.bySubject` collects it (`refs.subject`) —
 *  and a missing row otherwise reads as "never sponsored", which would hand the
 *  automation silently back to the app's owner the next time it fired. With this
 *  marker, marker-present + row-absent means "the sponsor is gone": the run
 *  stops. `refs` carry only `app_id`, so a subject erase
 *  cannot reach it and an app erase collects it. */
export const SPONSORED = "automations:sponsored";

/** The row id for anything keyed per (app, trigger).
 *
 *  An automation is an app with a LIST of triggers, and each trigger is armed,
 *  sponsored, scheduled and granted on its own — so every one of those rows is
 *  keyed by the pair, never by the app alone. App ids are `app_*` and trigger ids
 *  are bare identifiers, so neither half can contain the separator and the key
 *  cannot be ambiguous. Written down once because the engine keys five
 *  collections with it. */
export const triggerKey = (appId: string, triggerId: string): string => `${appId}:${triggerId}`;

/** Build contract §9.9 — one TRIGGER, one sponsor. Keyed by (appId, triggerId):
 *  two triggers of one app are two automations as far as consent goes, so each
 *  names the person it runs as on its own and an edit to one leaves the other
 *  running. */
export interface Sponsorship {
  appId: string;
  triggerId: string;
  /** The sponsor's subject. An automation always runs as a named person. */
  sponsor: string;
  /** The sponsor's own display name, as their Principal asserted it at enable.
   *  Captured with their consent in the same moment they arm the automation, so
   *  every surface can say "Dana" instead of `user_dana` without Vendo ever
   *  holding a directory. Absent when the host asserts no display name. */
  display?: string;
  /** Core `intentHash()` over the app's §7 intent at mint time. */
  intentHash: string;
  status: "active" | "invalidated";
  reason?: "edit" | "departure" | "grants";
  invalidatedAt?: IsoDateTime;
}

export const sponsorshipSchema = z.object({
  appId: z.string(),
  triggerId: z.string(),
  sponsor: z.string(),
  display: z.string().optional(),
  intentHash: z.string(),
  status: z.enum(["active", "invalidated"]),
  reason: z.enum(["edit", "departure", "grants"]).optional(),
  invalidatedAt: z.string().optional(),
}) satisfies z.ZodType<Sponsorship>;

/** The tools an automation DECLARES it will use: its steps' host tools, deduped
 *  and `fn:` refs excluded (those are the app's own code, not host authority).
 *  An agentic run declares nothing — its toolset is whatever the registry binds
 *  at fire time, which is not a declaration and must not enter the intent hash
 *  (a new connector would silently invalidate every agentic automation). */
export const declaredSurface = (trigger: Trigger | undefined): string[] =>
  trigger === undefined || trigger.run.kind !== "steps"
    ? []
    : [...new Set(trigger.run.steps.map((step) => step.tool).filter((tool) => !tool.startsWith("fn:")))];

/** The app's triggers, or none. The read-time normalization in core means a
 *  parsed document always carries the list, so this is only the empty default —
 *  written down once so no caller re-invents `?? []`. */
export const triggersOf = (doc: AppDocument): Trigger[] => doc.triggers ?? [];

/** One named trigger of an app, or undefined when the app has no such trigger. */
export const triggerOf = (doc: AppDocument, triggerId: string): Trigger | undefined =>
  triggersOf(doc).find((trigger) => trigger.id === triggerId);

/** Build contract §7's `AppIntent` for an automation document.
 *
 *  `runBody` is the canonical JSON of the trigger's RUN definition — for steps
 *  that is the ordered steps (tool, args, if, forEach), for an agentic run the
 *  prompt and budget. It is derived rather than hand-picked so that every part
 *  of "what this automation will do" is bound: an argument change is as much a
 *  change of intent as a new tool is, and a hash that ignored it would let an
 *  edit re-point a granted call at a different invoice. */
export const appIntentOf = (doc: AppDocument, trigger: Trigger | undefined): AppIntent => ({
  name: doc.name,
  triggerId: trigger?.id ?? "",
  tools: declaredSurface(trigger),
  trigger: (trigger?.on ?? null) as Json,
  runBody: trigger === undefined ? "" : canonicalJson(trigger.run),
});

/** The intent hash for ONE trigger of an app. Per trigger, so editing one
 *  trigger cannot invalidate another's consent — and two triggers declaring
 *  identical work still hash apart, because the id is in the preimage. */
export const currentIntentHash = (doc: AppDocument, trigger: Trigger | undefined): string =>
  intentHash(appIntentOf(doc, trigger));

/** The stored sponsorship, or undefined when there is none (an automation
 *  enabled before sponsorship shipped) or the row is unreadable.
 *
 *  A corrupt row therefore reads as NO row, which the caller resolves against
 *  the {@link SPONSORED} era marker — and since every sponsorship write stamps
 *  that marker, the automation fails CLOSED (it stops) rather than falling back
 *  to running as the app's owner. That is the intended answer: an unreadable
 *  sponsorship is not evidence that nobody took the automation on. */
export const readSponsorship = async (
  records: RecordStore,
  appId: string,
  triggerId: string,
): Promise<{ row: Sponsorship; revision?: string } | undefined> => {
  const record = await records.get(triggerKey(appId, triggerId));
  if (record === null) return undefined;
  const parsed = sponsorshipSchema.safeParse(record.data);
  if (!parsed.success) return undefined;
  return { row: parsed.data, ...(record.revision === undefined ? {} : { revision: record.revision }) };
};

/** Both refs are load-bearing: the 02-store §5 erase cascade collects generic
 *  rows by `refs.subject` (erasing the sponsor takes their name off the row)
 *  AND by `refs.app_id` (deleting the app takes its sponsorship with it). A row
 *  that survived either cascade would be a dangling name. */
const sponsorshipRefs = (row: Sponsorship): Record<string, string> =>
  ({ subject: row.sponsor, app_id: row.appId });

export const writeSponsorship = async (records: RecordStore, row: Sponsorship): Promise<void> => {
  await records.put({
    id: triggerKey(row.appId, row.triggerId),
    data: { ...row },
    refs: sponsorshipRefs(row),
  });
};

/** Record that this trigger is sponsored, without recording WHO. Idempotent. */
export const markSponsored = async (
  records: RecordStore,
  appId: string,
  triggerId: string,
  at: IsoDateTime,
): Promise<void> => {
  const id = triggerKey(appId, triggerId);
  if (await records.get(id) !== null) return;
  await records.put({ id, data: { appId, triggerId, since: at }, refs: { app_id: appId } });
};

/** Has this trigger ever been sponsored? A `false` here is what keeps automations
 *  armed before this lane shipped running as their owner. */
export const wasSponsored = async (
  records: RecordStore,
  appId: string,
  triggerId: string,
): Promise<boolean> => await records.get(triggerKey(appId, triggerId)) !== null;

/** A sponsorship row as it may actually be found ON DISK, in either key era.
 *
 *  Before an app had a LIST of triggers the row carried no trigger id, because
 *  there was only one trigger to name — so {@link sponsorshipSchema}, which is
 *  the contract shape every WRITE must satisfy, rejects those rows outright. A
 *  reader that used the strict schema therefore saw a pre-list row as no row at
 *  all. Absent reads as `main`, the id read normalization gives that one
 *  trigger. */
export const storedSponsorshipSchema = sponsorshipSchema.extend({
  triggerId: z.string().default(DEFAULT_TRIGGER_ID),
});

/**
 * Move a pre-list automation's sponsorship rows onto the (app, trigger) key, and
 * say whether anything moved.
 *
 * Sponsorship and its era marker were keyed by the bare `appId` before triggers
 * were a list, so under the pair key EVERY such row reads as ABSENT — and absent
 * means "never sponsored", the one branch that runs an automation as the app's
 * OWNER. A STOPPED automation would silently start running again, as a person
 * who never took it on. That is why this is a migration and not a read fallback:
 * the rows have to actually move, or every later read repeats the mistake.
 *
 * Two rules make the move safe:
 *  - The STATUS is carried verbatim. Active stays active, invalidated stays
 *    invalidated — a stopped automation stays stopped, which is the whole
 *    security property.
 *  - The intent hash is RECOMPUTED under the current formula, which now has the
 *    trigger id in its preimage. Carrying the old hash forward would fail the
 *    fire-time intent check for every still-active pre-list sponsorship, so a
 *    document nobody edited would stop.
 *
 * Only `main` can have a pre-list row, so nothing else is even looked for.
 */
export const migratePreListSponsorship = async (
  sponsorships: RecordStore,
  era: RecordStore,
  appId: string,
  triggerId: string,
  intentHash: string,
): Promise<boolean> => {
  if (triggerId !== DEFAULT_TRIGGER_ID) return false;
  let moved = false;
  const legacy = await sponsorships.get(appId);
  if (legacy !== null) {
    const parsed = storedSponsorshipSchema.safeParse(legacy.data);
    // An UNREADABLE row is left exactly where it is: it is already unreachable
    // (`readSponsorship` reads a corrupt row as no sponsorship), and deleting it
    // would destroy the only evidence of what it said.
    if (parsed.success) {
      await writeSponsorship(sponsorships, { ...parsed.data, triggerId, intentHash });
      await sponsorships.delete(appId);
      moved = true;
    }
  }
  const legacyEra = await era.get(appId);
  if (legacyEra !== null) {
    // The marker's payload is never read — only its presence is — so it is
    // carried forward verbatim rather than restamped with a `since` that would
    // claim this migration is when the automation was first sponsored.
    await era.put({
      id: triggerKey(appId, triggerId),
      data: { ...(legacyEra.data as Record<string, Json>), appId, triggerId },
      refs: { app_id: appId },
    });
    await era.delete(appId);
    moved = true;
  }
  return moved;
};
