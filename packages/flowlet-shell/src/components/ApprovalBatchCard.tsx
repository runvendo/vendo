import { useState } from "react";
import { toolAction } from "./tool-labels";
import type { ThreadItem } from "../use-flowlet-thread";

type BatchItem = Extract<ThreadItem, { kind: "approval" }>;

export interface ApprovalBatchCardProps {
  toolName: string;
  items: BatchItem[];
  onApproveAll: (approvalIds: string[], toolCallIds: string[]) => void;
  /** Selected ids first, then the batch's FULL id lists — the caller derives
   *  declined siblings as `allApprovalIds − approvalIds` (never by toolCallId
   *  matching, so an item with no toolCallId still gets its decline). */
  onApproveSubset: (
    approvalIds: string[], toolCallIds: string[], allApprovalIds: string[], allToolCallIds: string[],
  ) => void;
  onDeclineAll: (approvalIds: string[]) => void;
}

function summarize(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["to", "recipient", "recipient_email", "email"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return "";
}

/**
 * Spec §3 Moment 4 — "ten at once → one decision": sibling approval-requested
 * parts of the SAME tool in one assistant message render ONE grouped card.
 * "Approve all N" / "Pick which…" (expands checkboxes) / "No". Each included
 * item is still answered individually on the SDK's native approval channel
 * (the caller loops `addToolApprovalResponse`); this card only decides WHICH
 * approvalIds go in that loop.
 */
export function ApprovalBatchCard({ toolName, items, onApproveAll, onApproveSubset, onDeclineAll }: ApprovalBatchCardProps) {
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(items.map((i) => i.approvalId)));
  const action = toolAction(toolName);
  const allApprovalIds = items.map((i) => i.approvalId);
  const allToolCallIds = items.map((i) => i.toolCallId).filter((id): id is string => !!id);

  return (
    <div className="fl-approval" role="group" aria-label={`Approve ${items.length} ${action.done.toLowerCase()}`}>
      <div className="fl-approval-head">
        <div className="fl-approval-heading">
          <div className="fl-approval-eyebrow">Needs your approval</div>
          <div className="fl-approval-title">{action.request} {items.length} times?</div>
        </div>
      </div>
      {picking ? (
        <>
          <ul className="fl-approval-batch-list">
            {items.map((item) => (
              <li key={item.approvalId} className="fl-approval-batch-row">
                <label>
                  <input
                    type="checkbox"
                    aria-label={summarize(item.input) || item.toolCallId || item.approvalId}
                    checked={checked.has(item.approvalId)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(item.approvalId);
                      else next.delete(item.approvalId);
                      setChecked(next);
                    }}
                  />
                  {summarize(item.input) || action.request}
                </label>
              </li>
            ))}
          </ul>
          <div className="fl-approval-actions">
            <button
              type="button"
              className="fl-btn fl-btn-primary"
              onClick={() => {
                const selected = items.filter((i) => checked.has(i.approvalId));
                onApproveSubset(
                  selected.map((i) => i.approvalId),
                  selected.map((i) => i.toolCallId).filter((id): id is string => !!id),
                  allApprovalIds,
                  allToolCallIds,
                );
              }}
            >
              Approve selected
            </button>
            <button type="button" className="fl-btn" onClick={() => onDeclineAll(allApprovalIds)}>No</button>
          </div>
        </>
      ) : (
        <div className="fl-approval-actions">
          <button type="button" className="fl-btn fl-btn-primary" onClick={() => onApproveAll(allApprovalIds, allToolCallIds)}>
            Approve all {items.length}
          </button>
          <button type="button" className="fl-btn" onClick={() => setPicking(true)}>Pick which…</button>
          <button type="button" className="fl-btn" onClick={() => onDeclineAll(allApprovalIds)}>No</button>
        </div>
      )}
    </div>
  );
}
