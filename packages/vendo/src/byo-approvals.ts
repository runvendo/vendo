import {
  VendoError,
  type ApprovalId,
  type ApprovalRequest,
  type IsoDateTime,
  type Principal,
  type RecordStore,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
  type VendoRecord,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";

/**
 * Existing-agents Lane B — parked guarded calls with NO Vendo thread and NO app.
 *
 * A `vendo_*` pack tool executing in a BYO agent loop returns the
 * `vendo/approval-ref@1` envelope the instant the guard answers
 * `pending-approval` — no throw, no block. But nothing in the host's loop ever
 * re-dispatches the call: the thread resume path (`data-vendo-approval` stream
 * parts) needs Vendo's conversation, and the apps runtime's `ParkedAction`
 * pins an `appId` and lives with the app. This seam is the venue-neutral
 * third venue, riding the same three existing mechanisms end to end:
 *
 * - PARK: the {@link ByoApprovals.registry} decorator records the EXACT call
 *   (guard-minted id, tool, args) plus its `RunContext` when a guarded execute
 *   returns `pending-approval` — the same shape as `ParkedAction`, minus the
 *   app pin.
 * - RESUME: an umbrella-level `guard.onApprovalDecision` subscriber (the SAME
 *   seam the apps runtime and automations ride) re-dispatches the parked call
 *   byte-for-byte through the guard-bound registry on approve — the guard's
 *   one-shot approved replay pins subject, call id, args hash, descriptor
 *   hash, venue, presence, and appId, so the stored ctx is reused verbatim.
 *   Deny clears the record and never executes (fail closed).
 * - EXPIRE: {@link ByoApprovals.sweepExpired} denies parked calls older than
 *   the TTL through the existing abandonment path (`guard.abandonApprovals`
 *   semantics: deny + clear, idempotent) — a new trigger, not new semantics.
 *
 * The resume outcome persists keyed by approvalId so the wire can answer
 * "what happened to apr_x?" for `<VendoApprovalEmbed>` — in-thread that answer
 * rides the thread stream; there is no thread here.
 */

const PARKED_COLLECTION = "vendo_parked_call";
const OUTCOME_COLLECTION = "vendo_parked_call_outcome";

interface ParkedByoCall {
  /** The guard approval that gates this call. */
  approvalId: ApprovalId;
  /** The parking principal's subject — the only principal who may read it. */
  owner: string;
  /** The EXACT call the guard parked; a fresh call id would re-park, not run. */
  call: ToolCall;
  /** The context the call ran in — the approved replay pins venue/presence/appId. */
  ctx: RunContext;
  parkedAt: IsoDateTime;
  /** The pending request as the guard reported it at park time. `read` serves
   *  it while the record exists so a poll landing mid-resume (decided, outcome
   *  row not yet written) stays "pending" instead of a terminal not-found. */
  request?: ApprovalRequest;
  /** Set by the sweep just before it denies, so the decision subscriber
   *  resolves the outcome to "expired" instead of "declined". */
  expiring?: boolean;
}

interface ParkedByoOutcome {
  approvalId: ApprovalId;
  owner: string;
  state: "executed" | "declined" | "expired";
  /** Present for "executed": the resumed call's outcome, errors included. */
  outcome?: ToolOutcome;
  at: IsoDateTime;
}

/** The wire's answer to `GET /approvals/:id` — the frozen
 *  `VendoApprovalEmbedState` vocabulary, plus what each state needs to render:
 *  the full request while pending (the consent card shows real inputs), the
 *  executed outcome after resume. */
export type ByoApprovalResolution =
  | { state: "pending"; request: ApprovalRequest }
  | { state: "executed"; outcome: ToolOutcome }
  | { state: "declined" }
  | { state: "expired" };

export interface ByoApprovals {
  /** The guard-bound registry with approval parking — the registry the BYO
   *  tool pack executes through. Same decisions, same audit; the only
   *  addition is the parked record behind a `pending-approval` outcome. */
  registry: ToolRegistry;
  /** Resolve one approval's state for its owner; not-found for unknown or
   *  foreign ids (indistinguishable on purpose). */
  read(approvalId: string, principal: Principal): Promise<ByoApprovalResolution>;
  /** Deny every parked call idle past `ttlMs` through the existing
   *  abandonment path. No-op when `ttlMs` is 0 or negative. */
  sweepExpired(ttlMs: number, now?: number): Promise<void>;
}

export interface ByoApprovalsConfig {
  guard: VendoGuard;
  /** The guard-bound registry (the SAME binding chat, apps, and automations
   *  execute through) — both the parked call and its resume dispatch ride it. */
  tools: ToolRegistry;
  store: StoreAdapter;
}

function now(): IsoDateTime {
  return new Date().toISOString();
}

function cloneJson<T>(value: T): T {
  return globalThis.structuredClone(value);
}

async function listAll(store: RecordStore): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

export function createByoApprovals({ guard, tools, store }: ByoApprovalsConfig): ByoApprovals {
  const parked = store.records(PARKED_COLLECTION);
  const outcomes = store.records(OUTCOME_COLLECTION);

  const putParked = async (record: ParkedByoCall): Promise<void> => {
    await parked.put({
      id: record.approvalId,
      data: record,
      refs: { subject: record.owner, approval: record.approvalId },
    });
  };

  const putOutcome = async (record: ParkedByoOutcome): Promise<void> => {
    await outcomes.put({
      id: record.approvalId,
      data: record,
      refs: { subject: record.owner, state: record.state },
    });
  };

  // RESUME — the decision subscriber. `decide` fires callbacks exactly once
  // per approval (the pending→decided transition has a single atomic winner)
  // and awaits them, so the outcome row has one writer and lands before the
  // decide call returns to the wire.
  guard.onApprovalDecision(async (approvalId, approved) => {
    const record = await parked.get(approvalId);
    if (record === null) return;
    const data = record.data as ParkedByoCall;
    try {
      if (approved) {
        // Byte-for-byte re-dispatch: the one-shot approved replay executes it;
        // the guard binding folds a downstream throw into an error outcome.
        const outcome = await tools.execute(data.call, data.ctx);
        await putOutcome({ approvalId, owner: data.owner, state: "executed", outcome, at: now() });
      } else {
        await putOutcome({
          approvalId,
          owner: data.owner,
          state: data.expiring === true ? "expired" : "declined",
          at: now(),
        });
      }
    } finally {
      // Cleared either way: approve ran it, deny fails closed. A parked record
      // exists exactly while its approval is undecided.
      await parked.delete(approvalId);
    }
  });

  // EXPIRE — abandonApprovals is the guard's idempotent deny wrapper (already-
  // decided and unknown ids already hold the state abandonment wants). Older
  // Guard implementations may omit the optional method; the fallback applies
  // the same semantics through the plain decide path.
  const abandon = async (approvalId: ApprovalId, ctx: RunContext): Promise<void> => {
    if (guard.abandonApprovals !== undefined) {
      await guard.abandonApprovals([approvalId], ctx);
      return;
    }
    try {
      await guard.approvals.decide(approvalId, { approve: false }, ctx.principal);
    } catch (error) {
      if (error instanceof VendoError && (error.code === "conflict" || error.code === "not-found")) return;
      throw error;
    }
  };

  return {
    registry: {
      descriptors: () => tools.descriptors(),
      async execute(call, ctx) {
        const outcome = await tools.execute(call, ctx);
        if (outcome.status === "pending-approval") {
          // PARK — written right before the pack tool returns the
          // vendo/approval-ref@1 envelope to the foreign loop. The request
          // snapshot keeps `read` answering "pending" through the resume
          // window, after the decision has already left the guard's queue.
          const requests = await guard.approvals.pending(ctx.principal);
          const request = requests.find((candidate) => candidate.id === outcome.approvalId);
          await putParked({
            approvalId: outcome.approvalId,
            owner: ctx.principal.subject,
            call: cloneJson(call),
            ctx: cloneJson(ctx),
            parkedAt: now(),
            ...(request === undefined ? {} : { request: cloneJson(request) }),
          });
        }
        return outcome;
      },
    },

    async read(approvalId, principal) {
      const record = await outcomes.get(approvalId);
      if (record !== null) {
        const data = record.data as ParkedByoOutcome;
        if (data.owner === principal.subject) {
          if (data.state === "executed" && data.outcome !== undefined) {
            return { state: "executed", outcome: data.outcome };
          }
          if (data.state === "declined" || data.state === "expired") {
            return { state: data.state };
          }
        }
      }
      const pending = await guard.approvals.pending(principal);
      const request = pending.find((candidate) => candidate.id === approvalId);
      if (request !== undefined) return { state: "pending", request };
      // Mid-resume window: the decision already left the guard's pending queue
      // but the subscriber has not written the outcome row yet. The parked
      // record exists exactly until that write, so serve its request snapshot
      // as still-pending rather than a terminal not-found (which the embed
      // renders as expired and stops polling).
      const stillParked = await parked.get(approvalId);
      if (stillParked !== null) {
        const data = stillParked.data as ParkedByoCall;
        if (data.owner === principal.subject && data.request !== undefined) {
          return { state: "pending", request: data.request };
        }
      }
      throw new VendoError("not-found", `Approval ${approvalId} was not found`);
    },

    async sweepExpired(ttlMs, at = Date.now()) {
      if (ttlMs <= 0) return;
      for (const record of await listAll(parked)) {
        const data = record.data as ParkedByoCall;
        const parkedAt = Date.parse(data.parkedAt);
        if (Number.isFinite(parkedAt) && parkedAt + ttlMs > at) continue;
        // Mark first, so the deny lands as "expired" — the subscriber is the
        // outcome's single writer and reads the flag when the decision fires.
        // A concurrent user approve that wins the atomic decide still executes
        // and records "executed"; this abandon then no-ops (conflict).
        await putParked({ ...data, expiring: true });
        await abandon(data.approvalId, data.ctx);
      }
    },
  };
}
