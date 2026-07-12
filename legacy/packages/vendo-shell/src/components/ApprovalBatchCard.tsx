import { useState } from "react";
import { toolAction } from "./tool-labels";
import type { ThreadItem } from "../use-vendo-thread";

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

const SNIPPET_CHARS = 60;

/** A short, human row summary from the input's most identifying string field,
 *  plus a body/message snippet when one exists (live-verification polish
 *  2026-07-04: host-tool inputs like `{id, body}` summarized to "" and every
 *  picker row read identically — picking "which" was blind). */
function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  let identity = "";
  for (const key of ["to", "recipient", "recipient_email", "email", "name", "title", "subject", "id"]) {
    if (typeof record[key] === "string" && record[key]) { identity = record[key] as string; break; }
  }
  let snippet = "";
  for (const key of ["body", "message", "text"]) {
    const v = record[key];
    // Host-API tools nest the request body one level down ({body: {body: "…"}}).
    const s = typeof v === "string"
      ? v
      : v && typeof v === "object" && !Array.isArray(v)
        ? Object.values(v as Record<string, unknown>).find((x): x is string => typeof x === "string" && x.length > 0)
        : undefined;
    if (s) { snippet = s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)}…` : s; break; }
  }
  if (identity && snippet) return `${identity} — ${snippet}`;
  return identity || snippet;
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
  // Live-verification fix (2026-07-04): sibling approvals STREAM in — a set
  // seeded once at mount silently excluded later arrivals (an untouched
  // "Approve selected" then approved the first siblings and DECLINED the
  // rest). Until the user touches a checkbox, every current item counts as
  // checked; the explicit set only takes over after the first interaction.
  const [touched, setTouched] = useState(false);
  const [checkedState, setChecked] = useState<Set<string>>(new Set());
  const action = toolAction(toolName);
  const allApprovalIds = items.map((i) => i.approvalId);
  const allToolCallIds = items.map((i) => i.toolCallId).filter((id): id is string => !!id);
  const checked = touched ? checkedState : new Set(allApprovalIds);

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
            {items.map((item, index) => (
              <li key={item.approvalId} className="fl-approval-batch-row">
                <label>
                  <input
                    type="checkbox"
                    // Never a raw toolCallId — an unidentifiable input falls
                    // back to a positional human label.
                    aria-label={summarize(item.input) || `${action.request} ${index + 1} of ${items.length}`}
                    checked={checked.has(item.approvalId)}
                    onChange={(e) => {
                      // Seed from the derived all-checked view on first touch
                      // so the user's change applies to what they were seeing.
                      const next = new Set(checked);
                      if (e.target.checked) next.add(item.approvalId);
                      else next.delete(item.approvalId);
                      setChecked(next);
                      setTouched(true);
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
