import { useState } from "react";
import type { ToolItem } from "../use-flowlet-thread";
import { toolAction } from "./tool-labels";
import { isPolicyDenied, peekRows, stepSummary } from "./tool-output";
import { approvalRows } from "./field-rows";

export interface ActivityStepProps {
  step: ToolItem;
  /** When true, render the result peek beneath the row (panel expanded). */
  showPeek?: boolean;
}

/**
 * One tool call inside the activity panel. Settled MUTATING calls (act or
 * critical tier — carried on `step.tier`, ENG-193 §4.1/§4.5) additionally get
 * a quiet receipt affordance: "✓ <done label>" plus an expandable details row
 * reusing the same field-flattening ApprovalCard uses, so a receipt reads
 * exactly like the approval card that (maybe) preceded it (spec Moment 2 —
 * "asked → done → receipt", including calls that were silently allowed and
 * never showed a card at all).
 */
export function ActivityStep({ step, showPeek = false }: ActivityStepProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const label = toolAction(step.toolName);
  // A policy-denied SERVER tool returns its `{code:"policy_denied"}` payload
  // as an ORDINARY `output-available` result (its `execute` short-circuited
  // the deny instead of throwing — see wrap-tool.ts) — `state` alone reads as
  // success. Finding 1: carve it out of `done` so it never earns a ✓ tick or
  // a receipt for a call that was actually blocked, not run.
  const blocked = step.state === "output-available" && isPolicyDenied(step.output);
  const done = step.state === "output-available" && !blocked;
  const errored = step.state === "output-error";
  const denied = step.state === "output-denied";
  const rows = showPeek && done ? peekRows(step.output) : [];
  const isReceipt = done && step.tier !== undefined;
  // Mirror ApprovalCard's own maxChars-null-for-critical rule (finding 2
  // knock-on): the receipt is documented above to "read exactly like the
  // approval card that (maybe) preceded it" — a critical card never
  // truncates OR caps its rows, and the receipt must not silently regress
  // that guarantee just because the card is gone and only the receipt is
  // left to show the same fields.
  const { rows: detailRows } = isReceipt
    ? approvalRows(step.input, step.tier === "critical" ? null : 160)
    : { rows: [] };

  return (
    <div className="fl-act-step" data-testid="activity-step" data-state={step.state}>
      <div className="fl-act-row">
        <span className="fl-act-ic" aria-hidden="true">
          {errored ? <span className="fl-act-x">✕</span>
            : denied || blocked ? <span className="fl-act-denied">⊘</span>
            : done ? <span className="fl-act-tick">✓</span>
            : <span className="fl-act-spin" />}
        </span>
        <span className="fl-act-lbl">{errored ? `${label.done} failed` : done ? label.done : label.active}</span>
        {errored && step.errorText ? (
          <span className="fl-act-sub fl-act-err">{step.errorText}</span>
        ) : denied ? (
          <span className="fl-act-sub">Declined — didn&apos;t run</span>
        ) : blocked ? (
          <span className="fl-act-sub">Blocked by your settings</span>
        ) : (
          done && <span className="fl-act-sub">{stepSummary(step.output)}</span>
        )}
        {isReceipt && detailRows.length > 0 && (
          <button type="button" className="fl-receipt" onClick={() => setDetailsOpen((v) => !v)}>
            details
          </button>
        )}
      </div>
      {isReceipt && detailsOpen && detailRows.length > 0 && (
        <dl className="fl-approval-fields fl-receipt-fields">
          {detailRows.map((row) => (
            <div key={row.label} className="fl-approval-field">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <div className="fl-act-peek">
          {rows.map((r, i) => (
            <div key={i} className="fl-act-peek-row">
              <span className="fl-act-peek-k">{r.label}</span>
              <span className="fl-act-peek-v">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
