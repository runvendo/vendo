/**
 * §9.9 — who an automation runs as, and whether it may still run at all: the ONE
 * sponsorship read, the run context built from it, and the fire-time gate every
 * firing passes before a single tool call.
 */
import type { AutomationRecord, RunContext } from "@vendoai/core";
import type { EngineBase } from "./engine-context.js";
import { stopFor } from "./messages.js";
import { allRecords } from "./rows.js";
import {
  currentIntentHash,
  readSponsorship,
  SPONSORSHIPS,
  sponsorshipSchema,
  wasSponsored,
  writeSponsorship,
  type Sponsorship,
} from "./sponsorship.js";
import type { InternalRunRecord } from "./types.js";

export type SponsorshipGateDeps = { base: EngineBase };

export interface SponsorshipGateAccess {
  /** The ONE sponsorship read every gate goes through. */
  sponsorshipState(
    automationId: string,
  ): Promise<{ kind: "none" } | { kind: "erased" } | { kind: "row"; row: Sponsorship }>;
  /** Every sponsorship row for these records, in ONE query. */
  sponsorshipsFor(records: readonly AutomationRecord[]): Promise<Map<string, Sponsorship>>;
  /** The run's context before any seam is consulted. */
  baseRunContext(run: InternalRunRecord, subject: string): RunContext;
  /** §9.9 — the run's identity is its SPONSOR. */
  runContext(run: InternalRunRecord, subject: string): Promise<RunContext>;
  /** §9.9's fire-time gate, in ONE place. */
  sponsorshipRefusal(
    record: AutomationRecord,
  ): Promise<{ reason: NonNullable<Sponsorship["reason"]>; summary: string } | undefined>;
}

type SponsorshipReader = Pick<SponsorshipGateAccess, "sponsorshipState" | "sponsorshipsFor">;

const createSponsorshipReader = ({ base: { engine } }: SponsorshipGateDeps): SponsorshipReader => {
  /** The sponsorship as the gates see it: the row, or — when the row is gone but
   *  the automation was sponsored once — the fact that its sponsor was ERASED. */
  const sponsorshipState = async (
    automationId: string,
  ): Promise<{ kind: "none" } | { kind: "erased" } | { kind: "row"; row: Sponsorship }> => {
    const row = await readSponsorship(engine, automationId);
    if (row !== undefined) return { kind: "row", row };
    return await wasSponsored(engine, automationId) ? { kind: "erased" } : { kind: "none" };
  };

  const sponsorshipsFor = async (
    records: readonly AutomationRecord[],
  ): Promise<Map<string, Sponsorship>> => {
    if (records.length === 0) return new Map();
    const rows = new Map<string, Sponsorship>();
    for (const stored of await allRecords(engine, SPONSORSHIPS, { ids: records.map(({ id }) => id) })) {
      const parsed = sponsorshipSchema.safeParse(stored.data);
      if (parsed.success) rows.set(parsed.data.automationId, parsed.data);
    }
    return rows;
  };

  return { sponsorshipState, sponsorshipsFor };
};

/** §9.9 — who a firing runs as, and whether it may run at all. */
const createRunIdentity = (
  deps: SponsorshipGateDeps & Pick<SponsorshipReader, "sponsorshipState">,
): Pick<SponsorshipGateAccess, "baseRunContext" | "runContext" | "sponsorshipRefusal"> => {
  const { base: { config, engine, iso }, sponsorshipState } = deps;
  /** The run's context before any seam is consulted — a pure function of the run
   *  and a subject, so it cannot fail. It is what a failed identity resolution
   *  still audits under: a fire that cannot even resolve who it runs as must
   *  leave a record, not vanish. */
  const baseRunContext = (run: InternalRunRecord, subject: string): RunContext => ({
    principal: { kind: "user", subject },
    venue: "automation",
    presence: "away",
    sessionId: `sess_${run.id}`,
    // The firing record's own id rides here because the guard's away-grant
    // lookup matches on it: without it an away call holds no automation
    // authority at all. `lineageId` is the FIRING, not just the run: the guard's
    // effect ledger keys receipts on it, so a re-run can see what the run it
    // re-runs already completed. A run that is nobody's re-run is its own root.
    trigger: {
      runId: run.id,
      kind: run.trigger.kind,
      automationId: run.automationId,
      lineageId: run.__lineage ?? run.id,
    },
  });

  /** §9.9 — the run's identity is its SPONSOR: an automation always runs as a
   *  named person. The record's own owner is the fallback for a sponsorship that
   *  has lapsed (the fire-time gate below stops those runs anyway). */
  const runContext = async (run: InternalRunRecord, subject: string): Promise<RunContext> => {
    const state = await sponsorshipState(run.automationId);
    const ctx = baseRunContext(
      run,
      state.kind === "row" && state.row.status === "active" ? state.row.sponsor : subject,
    );
    // §9.1 — memberships are ASSERTED per run, never stored: an unattended fire
    // has no session, so the engine resolves them from the host's own callback
    // and rides them on the ctx (the schema is passthrough, like `inClient` on
    // the open payload).
    const memberships = await config.memberships?.(ctx.principal);
    if (memberships !== undefined) {
      (ctx as RunContext & { memberships?: readonly unknown[] }).memberships = memberships;
    }
    return ctx;
  };

  /** §9.9's fire-time gate: a run may proceed only while the sponsorship is
   *  active and the intent it was minted over is still what the record does. A
   *  failure marks the sponsorship invalidated and the caller stops the run
   *  loudly before any tool call. */
  const sponsorshipRefusal = async (
    record: AutomationRecord,
  ): Promise<{ reason: NonNullable<Sponsorship["reason"]>; summary: string } | undefined> => {
    const state = await sponsorshipState(record.id);
    // Never sponsored: a record created disarmed and fired by some other door
    // keeps running as its owner rather than being stopped by a ceremony it
    // never went through.
    if (state.kind === "none") return undefined;
    // The sponsor's data was erased. Fail CLOSED — nothing is written here (a
    // write would re-create the row an erase just removed).
    if (state.kind === "erased") return stopFor("departure", record);
    const { row } = state;
    if (row.status !== "active") return stopFor(row.reason ?? "edit", record);
    if (row.intentHash === currentIntentHash(record)) return undefined;
    await writeSponsorship(engine, { ...row, status: "invalidated", reason: "edit", invalidatedAt: iso() });
    return stopFor("edit", record);
  };

  return { baseRunContext, runContext, sponsorshipRefusal };
};

export const createSponsorshipGate = (deps: SponsorshipGateDeps): SponsorshipGateAccess => {
  const reader = createSponsorshipReader(deps);
  return { ...reader, ...createRunIdentity({ ...deps, ...reader }) };
};
