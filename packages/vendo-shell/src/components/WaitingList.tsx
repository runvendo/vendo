import { toolAction } from "./tool-labels";
import { relativeTimeLabel } from "../relative-time";

export interface ParkedActionRow {
  id: string;
  tool: string;
  tier: "act" | "critical";
  inputPreview: string;
  requestedAt: string;
  guardStale?: boolean;
}

export interface WaitingListProps {
  actions: ParkedActionRow[];
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}

/**
 * "Waiting on you" (spec §3 Moment 8/§4.6) — parked actions from unattended
 * automation runs. Each row gets the SAME ceremony register `ApprovalCard`
 * uses for critical tools (money/irreversible never loses its weight just
 * because it arrived while the user was away). Standalone from the thread —
 * a parked action has no message/turn to render inside (plan deviation #4).
 */
export function WaitingList({ actions, onApprove, onDecline }: WaitingListProps) {
  if (actions.length === 0) return null;
  return (
    <div className="fl-waiting" role="region" aria-label="Waiting on you">
      <div className="fl-waiting-head">Waiting on you ({actions.length})</div>
      {actions.map((action) => {
        const label = toolAction(action.tool);
        const critical = action.tier === "critical";
        // requestedAt is an ISO timestamp (store-stamped); relativeTimeLabel
        // takes epoch ms (same convention FlowGallery's updatedAt uses).
        const requestedMs = Date.parse(action.requestedAt);
        return (
          <div key={action.id} className={`fl-waiting-row${critical ? " fl-waiting-row--ceremony" : ""}`}>
            <div className="fl-waiting-row-main">
              <span className="fl-waiting-ic" aria-hidden="true">⏳</span>
              <div className="fl-waiting-row-body">
                <div className="fl-waiting-row-title">{label.question}</div>
                <div className="fl-waiting-row-preview">{action.inputPreview}</div>
                <div className="fl-waiting-row-meta">
                  {relativeTimeLabel(requestedMs)}
                  {action.guardStale && (
                    // The run's conditions referenced other steps' outputs —
                    // the resolve path never re-checks those (frozen input
                    // executes as-is), so the row says so plainly instead of
                    // fabricating a review that hasn't happened.
                    <span className="fl-waiting-stale"> · conditions can&apos;t be re-verified — review carefully</span>
                  )}
                </div>
              </div>
            </div>
            <div className="fl-waiting-actions">
              <button
                type="button"
                className={`fl-btn ${critical ? "fl-btn-ceremony" : "fl-btn-primary"}`}
                onClick={() => onApprove(action.id)}
              >
                {critical ? `Confirm ${label.request.replace(/^[A-Z]/, (c) => c.toLowerCase())}` : "Approve"}
              </button>
              <button type="button" className="fl-btn" onClick={() => onDecline(action.id)}>Decline</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
