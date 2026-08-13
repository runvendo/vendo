import {
  PARKED_ACTION_COLLECTION,
  PARKED_CALL_OUTCOME_COLLECTION,
  type AppId,
  type ApprovalId,
  type ParkedCallOutcome,
  type RunContext,
  type ToolCall,
  type ToolOutcome,
  type VendoRecord,
} from "@vendoai/core";
import type { EngineOps } from "./engine.js";
import { listAllEngineRecords } from "./persistence.js";

/**
 * W0 — parked in-app actions (the approve→resume engine seam).
 *
 * A mutating in-app action (`runtime.call`) that the guard sends to approval
 * returns `pending-approval` to the surface — the action shows "Running". The
 * guard parks the approval; deciding it approved makes the EXACT same call
 * eligible for a one-shot approved replay (guard `#consumeApprovedCall`), but
 * only if someone re-dispatches it. Nobody did — so every gated mutation
 * stalled at "Running" forever (held-out gate C4/C11).
 *
 * This collection records the exact parked call (its guard-minted id, args, and
 * the app-venue context it ran in) keyed by the approval that gates it, so the
 * runtime's `onApprovalDecision` subscriber can re-dispatch it the instant the
 * owner approves — the SAME onApprovalDecision seam exposure/egress already
 * ride. A parked record exists exactly while its approval is undecided; both
 * decisions clear it (approve re-dispatches then clears; deny just clears —
 * fail closed, the effect never lands).
 *
 * Hygiene mirrors the egress/exposure stores: records live in their own
 * collection keyed by app id (a copy's fresh id has none) and are cleared with
 * the app on delete.
 *
 * The resume ANSWER outlives the parked record: the surface that pressed the
 * button has long since had its `pending-approval` back, so what happened is
 * persisted as a {@link ParkedCallOutcome} — the same row (and drawer) the BYO
 * lane writes — and `GET /approvals/:id` serves it to the waiting screen. Without
 * it a gated press sat on "waiting for approval" forever even once it had run.
 */
export interface ParkedAction {
  /** The guard approval that gates this call. */
  approvalId: ApprovalId;
  appId: AppId;
  /** The app owner's principal subject — the only principal who may approve. */
  owner: string;
  /**
   * The EXACT call the guard parked: its guard-minted id, tool, and args. The
   * approved replay matches on call id + args + descriptor, so this must be
   * re-dispatched byte-for-byte — a fresh call id would re-park, not run.
   */
  call: ToolCall;
  /** The app-venue context the call ran in (venue/presence/appId/subject) — the
   *  approved replay also pins these, so re-dispatch reuses them verbatim. */
  ctx: RunContext;
}

const COLLECTION = PARKED_ACTION_COLLECTION;

const parkedData = (record: VendoRecord): ParkedAction => record.data as ParkedAction;

const listAll = (engine: EngineOps, refs: Record<string, string>): Promise<VendoRecord[]> =>
  listAllEngineRecords(engine, COLLECTION, { refs });

export interface ParkedActions {
  /** Park one in-app action on its guard approval (re-parking overwrites). */
  put(action: ParkedAction): Promise<void>;
  /** The action riding a specific guard approval id, or null if none. */
  byApproval(approvalId: ApprovalId): Promise<ParkedAction | null>;
  /** Record what the decision did with the action, for the surface that parked
   *  it to read back. "expired" is not in this lane's vocabulary: a TTL sweep
   *  reaches the guard's deny path, which reports itself as a plain denial. */
  resolve(
    action: ParkedAction,
    result: { state: "executed"; outcome: ToolOutcome } | { state: "declined" },
  ): Promise<void>;
  /** Clear the parked action for one approval (its approval was decided, either way). */
  remove(approvalId: ApprovalId): Promise<void>;
  /** Delete every parked action for one app (app deletion cleanup). */
  clearForApp(appId: AppId): Promise<void>;
}

export const createParkedActions = (engine: EngineOps): ParkedActions => {
  return {
    async put(action) {
      await engine.put(COLLECTION, {
        id: action.approvalId,
        data: action,
        refs: { subject: action.owner, app_id: action.appId, approval: action.approvalId },
      });
    },
    async byApproval(approvalId) {
      const record = await engine.get(COLLECTION, approvalId);
      return record === null ? null : parkedData(record);
    },
    async resolve(action, result) {
      const outcome: ParkedCallOutcome = {
        approvalId: action.approvalId,
        owner: action.owner,
        ...result,
        at: new Date().toISOString(),
      };
      await engine.put(PARKED_CALL_OUTCOME_COLLECTION, {
        id: outcome.approvalId,
        data: outcome,
        refs: { subject: outcome.owner, state: outcome.state },
      });
    },
    async remove(approvalId) {
      await engine.delete(COLLECTION, approvalId);
    },
    async clearForApp(appId) {
      for (const record of await listAll(engine, { app_id: appId })) {
        await engine.delete(COLLECTION, record.id);
      }
    },
  };
};
