/** ENG-193 §4.6 / ENG-225 — the "waiting on you" strip: every approval parked
    while the user was away, decidable in place. Renders nothing while the queue
    is empty; height-capped with internal scroll (see .fl-waiting in chrome-css)
    so a deep inbox never starves the surface that mounts it. */
import type { ApprovalRequest } from "@vendoai/core";
import { useVendoContext } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { formatAuditTime } from "./activity-semantics.js";
import { ChromeRoot } from "./chrome-root.js";
import { toolTitle } from "./humanize.js";

export interface WaitingQueueProps {
  /** Poll cadence for pending approvals; 0 disables polling. */
  pollMs?: number;
}

function WaitingRow({ approval, onDecide }: {
  approval: ApprovalRequest;
  onDecide(approve: boolean): void;
}) {
  const { tools } = useVendoContext();
  // A destructive ask reads as ceremony — the warm wash + warn title.
  const ceremony = approval.descriptor.risk === "destructive";
  return (
    <div className={`fl-waiting-row${ceremony ? " fl-waiting-row--ceremony" : ""}`}>
      <div className="fl-waiting-row-main">
        <span className="fl-waiting-ic" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
          </svg>
        </span>
        <div>
          <div className="fl-waiting-row-title">{toolTitle(approval.call.tool, tools[approval.call.tool])}</div>
          {approval.inputPreview ? <div className="fl-waiting-row-preview">{approval.inputPreview}</div> : null}
          <div className="fl-waiting-row-meta">Asked {formatAuditTime(approval.createdAt)}</div>
        </div>
      </div>
      <div className="fl-waiting-actions">
        <button type="button" className="fl-btn" onClick={() => onDecide(false)}>Deny</button>
        <button type="button" className="fl-btn fl-btn-primary" onClick={() => onDecide(true)}>Approve</button>
      </div>
    </div>
  );
}

/** The waiting-on-you queue (08-ui §4 chrome; mounted by VendoPage's chat
    workspace, exportable for any host placement). */
export function WaitingQueue({ pollMs = 5_000 }: WaitingQueueProps = {}) {
  const { pending, decide } = useApprovals(pollMs > 0 ? { pollMs } : {});
  if (pending.length === 0) return null;
  return (
    <ChromeRoot>
      <section className="fl-waiting" aria-label="Waiting on you">
        <div className="fl-waiting-head">Waiting on you · {pending.length}</div>
        {pending.map(approval => (
          <WaitingRow
            key={approval.id}
            approval={approval}
            onDecide={approve => void decide(approval.id, { approve })}
          />
        ))}
      </section>
    </ChromeRoot>
  );
}
