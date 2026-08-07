/**
 * §9.9 — who an automation runs as, and whether it may still run at all: the ONE
 * migrating sponsorship read, the run context built from it, and the fire-time
 * gate every firing passes before a single tool call.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  DEFAULT_TRIGGER_ID,
  type AppDocument,
  type RecordStore,
  type RunContext,
  type Trigger,
} from "@vendoai/core";
import type { AutomationsEngineContext } from "./engine-context.js";
import { stopFor } from "./messages.js";
import { allRecords } from "./rows.js";
import {
  currentIntentHash,
  migratePreListSponsorship,
  readSponsorship,
  SPONSORED,
  SPONSORSHIPS,
  sponsorshipSchema,
  triggerKey,
  triggerOf,
  triggersOf,
  wasSponsored,
  writeSponsorship,
  type Sponsorship,
} from "./sponsorship.js";
import type { AppRow, InternalRunRecord } from "./types.js";

export type SponsorshipGateDeps = Pick<AutomationsEngineContext, "config" | "iso" | "canEdit">;

export type SponsorshipGateAccess = Pick<
  AutomationsEngineContext,
  | "sponsorships"
  | "sponsoredEra"
  | "sponsorshipState"
  | "sponsorshipsFor"
  | "baseRunContext"
  | "runContext"
  | "sponsorshipRefusal"
>;

type SponsorshipReader = Pick<
  AutomationsEngineContext,
  "sponsorships" | "sponsoredEra" | "sponsorshipState" | "sponsorshipsFor"
>;

/** The sponsorship rows, and the ONE migrating read every gate goes through. */
const createSponsorshipReader = ({ config }: Pick<SponsorshipGateDeps, "config">): SponsorshipReader => {
  const sponsorships = (): RecordStore => config.store.records(SPONSORSHIPS);
  const sponsoredEra = (): RecordStore => config.store.records(SPONSORED);

  /** The sponsorship as the gates see it: the row, or — when the row is gone but
   *  the app was sponsored once — the fact that its sponsor was ERASED.
   *
   *  The ONE door every sponsorship read goes through, because it is also where
   *  the pre-list rekey is migrated: a row keyed by the bare app id is invisible
   *  under the pair key, and invisible reads as "never sponsored", which runs the
   *  automation as its OWNER. Taking the document rather than just its id is what
   *  lets the migration recompute the intent hash under the current formula. */
  const sponsorshipState = async (
    doc: AppDocument,
    triggerId: string,
  ): Promise<
    | { kind: "none" }
    | { kind: "erased" }
    | { kind: "row"; row: Sponsorship; revision?: string }
  > => {
    const appId = doc.id;
    const read = async (): Promise<
      { kind: "erased" } | { kind: "row"; row: Sponsorship; revision?: string } | undefined
    > => {
      const found = await readSponsorship(sponsorships(), appId, triggerId);
      if (found !== undefined) return { kind: "row", ...found };
      return await wasSponsored(sponsoredEra(), appId, triggerId) ? { kind: "erased" } : undefined;
    };
    const current = await read();
    if (current !== undefined) return current;
    const moved = await migratePreListSponsorship(
      sponsorships(),
      sponsoredEra(),
      appId,
      triggerId,
      currentIntentHash(doc, triggerOf(doc, triggerId)),
    );
    return (moved ? await read() : undefined) ?? { kind: "none" };
  };

  /**
   * Every sponsorship row for these apps' triggers, in ONE query — and the
   * pre-list rekey, because the LIST is where a person reads who an automation
   * runs as (§13) and whether it stopped. A row that is invisible here does not
   * merely go missing: both sentences then answer with the app's OWNER, so an
   * automation someone else took on reads as the reader's own, and a STOPPED one
   * shows no stopped line and no way back to it.
   *
   * The batch is kept. Only a `main` key that MISSED can be pre-list, and those
   * app ids are probed in one further batched read; a deployment with no pre-list
   * rows never issues it. Migration itself stays where it belongs — the one door
   * — so this consults `sponsorshipState` rather than repeating it.
   */
  const sponsorshipsFor = async (rows: readonly AppRow[]): Promise<Map<string, Sponsorship>> => {
    const keys = rows.flatMap((row) =>
      triggersOf(row.doc).map((trigger) => triggerKey(row.doc.id, trigger.id)));
    if (keys.length === 0) return new Map();
    const byTrigger = new Map<string, Sponsorship>();
    for (const record of await allRecords(sponsorships(), { ids: keys })) {
      const parsed = sponsorshipSchema.safeParse(record.data);
      if (parsed.success) byTrigger.set(triggerKey(parsed.data.appId, parsed.data.triggerId), parsed.data);
    }
    // Pair keys are `<appId>:<triggerId>` and app ids are `app_*`, so a bare app
    // id can never collide with one: this probe reads the pre-list key and only
    // the pre-list key.
    const unresolved = new Map(rows
      .filter((row) => triggersOf(row.doc).some((trigger) => trigger.id === DEFAULT_TRIGGER_ID))
      .filter((row) => !byTrigger.has(triggerKey(row.doc.id, DEFAULT_TRIGGER_ID)))
      .map((row) => [row.doc.id, row]));
    if (unresolved.size === 0) return byTrigger;
    for (const record of await allRecords(sponsorships(), { ids: [...unresolved.keys()] })) {
      const row = unresolved.get(record.id);
      if (row === undefined) continue;
      const state = await sponsorshipState(row.doc, DEFAULT_TRIGGER_ID);
      if (state.kind === "row") byTrigger.set(triggerKey(row.doc.id, DEFAULT_TRIGGER_ID), state.row);
    }
    return byTrigger;
  };

  return { sponsorships, sponsoredEra, sponsorshipState, sponsorshipsFor };
};

/** §9.9 — who a firing runs as, and whether it may run at all. */
const createRunIdentity = (
  deps: Pick<SponsorshipGateDeps, "config" | "iso" | "canEdit">
    & Pick<SponsorshipReader, "sponsorships" | "sponsorshipState">,
): Pick<AutomationsEngineContext, "baseRunContext" | "runContext" | "sponsorshipRefusal"> => {
  const { config, iso, canEdit, sponsorships, sponsorshipState } = deps;
  /** The run's context before any seam is consulted — a pure function of the run
   *  and a subject, so it cannot fail. It is what a failed identity resolution
   *  still audits under: a fire that cannot even resolve who it runs as must
   *  leave a record, not vanish. */
  const baseRunContext = (run: InternalRunRecord, subject: string): RunContext => ({
    principal: { kind: "user", subject },
    venue: "automation",
    presence: "away",
    sessionId: `sess_${run.id}`,
    appId: run.appId,
    // The firing trigger's own id rides here because the guard's away-grant
    // lookup matches on (app, trigger): without it a grant minted while arming
    // one trigger would authorize every sibling trigger's away calls, which is
    // the arm-time rule this run is supposed to be living under. `lineageId` is
    // the FIRING, not just the run: the guard's effect ledger keys receipts on
    // it, so a re-run can see what the run it re-runs already completed. A run
    // that is nobody's re-run is its own root.
    trigger: {
      runId: run.id,
      kind: run.trigger.kind,
      id: run.triggerId,
      lineageId: run.__lineage ?? run.id,
    },
  });

  /** §9.9 — the run's identity is its SPONSOR: an automation always runs as a
   *  named person. The app row's subject is the fallback for automations armed
   *  before sponsorship existed, and for a sponsorship that has lapsed (the
   *  fire-time gate below stops those runs anyway). */
  const runContext = async (doc: AppDocument, run: InternalRunRecord, subject: string): Promise<RunContext> => {
    // Through the migrating door, not `readSponsorship` — this read happens
    // BEFORE the fire-time gate below (the gate needs the sponsor's identity to
    // ask `can(editor)`), so a pre-list row still keyed by the app alone would
    // otherwise decide the run's identity while invisible.
    const state = await sponsorshipState(doc, run.triggerId);
    const ctx = baseRunContext(
      run,
      state.kind === "row" && state.row.status === "active" ? state.row.sponsor : subject,
    );
    const principal = ctx.principal;
    // §9.1 — memberships are ASSERTED per run, never stored: an unattended fire
    // has no session, so the engine resolves them from the host's own callback
    // and rides them on the ctx (the schema is passthrough, like `inClient` on
    // the open payload). `can()` reads them from there and never queries them.
    const memberships = await config.memberships?.(principal);
    if (memberships !== undefined) {
      (ctx as RunContext & { memberships?: readonly unknown[] }).memberships = memberships;
    }
    return ctx;
  };

  /** §9.9's fire-time gate, in ONE place: a run may proceed only while the
   *  sponsorship is active, the stored intent still matches the live document,
   *  and the sponsor can still edit the app. Any failure marks the sponsorship
   *  invalidated and the caller stops the run loudly before any tool call. */
  const sponsorshipRefusal = async (
    app: AppRow,
    trigger: Trigger,
    ctx: RunContext,
  ): Promise<{ reason: NonNullable<Sponsorship["reason"]>; summary: string } | undefined> => {
    const state = await sponsorshipState(app.doc, trigger.id);
    // Never sponsored: an automation armed before sponsorship shipped keeps
    // running as its owner rather than being stopped by a feature it predates.
    if (state.kind === "none") return undefined;
    // The sponsor's data was erased. Fail CLOSED — nothing is written here (a
    // write would re-create the row an erase just removed), and the card is
    // derived from this same state below.
    if (state.kind === "erased") return stopFor("departure", app.doc.name);
    const { row } = state;
    const refusal = (reason: NonNullable<Sponsorship["reason"]>) => stopFor(reason, app.doc.name);
    if (row.status !== "active") return refusal(row.reason ?? "edit");
    const invalidate = async (reason: NonNullable<Sponsorship["reason"]>) => {
      await writeSponsorship(sponsorships(), {
        ...row,
        status: "invalidated",
        reason,
        invalidatedAt: iso(),
      });
      return refusal(reason);
    };
    if (row.intentHash !== currentIntentHash(app.doc, trigger)) return await invalidate("edit");
    // §9.9's vocabulary distinguishes the two ways a sponsor stops being able to
    // run it: "departure" is the person being GONE (the erased-sponsor branch
    // above), "grants" is the person still being there and having lost access —
    // which is exactly what a failed `can(editor)` means. They produce different
    // consumer sentences, so the label is not cosmetic.
    if (!await canEdit(ctx, app, app.doc.id)) return await invalidate("grants");
    return undefined;
  };

  return { baseRunContext, runContext, sponsorshipRefusal };
};

export const createSponsorshipGate = (deps: SponsorshipGateDeps): SponsorshipGateAccess => {
  const reader = createSponsorshipReader(deps);
  return { ...reader, ...createRunIdentity({ ...deps, ...reader }) };
};
