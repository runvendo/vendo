import {
  type AppId,
  type ApprovalId,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type VendoRecord,
} from "@vendoai/core";

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

const COLLECTION = "vendo_parked_action";

const parkedData = (record: VendoRecord): ParkedAction => record.data as ParkedAction;

const listAll = async (
  store: StoreAdapter,
  refs: Record<string, string>,
): Promise<VendoRecord[]> => {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.records(COLLECTION).list(
      cursor === undefined ? { refs } : { refs, cursor },
    );
    records.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
};

export interface ParkedActions {
  /** Park one in-app action on its guard approval (re-parking overwrites). */
  put(action: ParkedAction): Promise<void>;
  /** The action riding a specific guard approval id, or null if none. */
  byApproval(approvalId: ApprovalId): Promise<ParkedAction | null>;
  /** Clear the parked action for one approval (its approval was decided, either way). */
  remove(approvalId: ApprovalId): Promise<void>;
  /** Delete every parked action for one app (app deletion cleanup). */
  clearForApp(appId: AppId): Promise<void>;
}

export const createParkedActions = (store: StoreAdapter): ParkedActions => {
  const collection = store.records(COLLECTION);
  return {
    async put(action) {
      await collection.put({
        id: action.approvalId,
        data: action,
        refs: { subject: action.owner, app_id: action.appId, approval: action.approvalId },
      });
    },
    async byApproval(approvalId) {
      const record = await collection.get(approvalId);
      return record === null ? null : parkedData(record);
    },
    async remove(approvalId) {
      await collection.delete(approvalId);
    },
    async clearForApp(appId) {
      for (const record of await listAll(store, { app_id: appId })) {
        await collection.delete(record.id);
      }
    },
  };
};
