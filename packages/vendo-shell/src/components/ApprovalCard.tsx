import { toolAction } from "./tool-labels";
import { approvalRows } from "./field-rows";

export interface ApprovalCardProps {
  toolName: string;
  input: unknown;
  /** ENG-193 §4.1 — from the sibling data-consent part. Defaults to "act". */
  tier?: "act" | "critical";
  /** Yousef ruling: unknown-annotation tools land in act but are flagged. */
  unverified?: boolean;
  /** The judge/breaker's plain-language escalation reason (ENG-193 §4.2/§4.7),
   *  from the sibling data-consent part. Absent for an ordinary approval. */
  reason?: string;
  /** Voice sessions (ENG-185): a soft listening ring while a spoken yes is
   *  acceptable. Critical-tier cards never listen — voice only announces. */
  listening?: boolean;
  /** Settled state — the card becomes a receipt of how consent was given. */
  resolution?: "voice" | "tap" | "declined";
  /** Consequence line override for critical-tier cards. Default:
   *  "This can't be undone." */
  consequence?: string;
  onApprove: () => void;
  onDecline: () => void;
}

const MAX_VALUE_CHARS = 160;

/**
 * The consent moment (spec §3 Moments 3, 6 & 9): a plain yes/no card for an
 * act-tier action, the ceremony variant for critical (money/irreversible)
 * actions, or — new in ENG-193 item 3 — the ESCALATION register when the
 * judge or a breaker stopped to check: a reason line and the SAFE action
 * (decline) made primary instead of approve (spec Moment 9's button-priority
 * flip). Critical's own ceremony register always wins over the escalation
 * register — money/irreversible ceremony doesn't need a reason to already
 * be maximally careful.
 *
 * Voice sessions (ENG-185) layer on top: `listening` adds a soft ring while
 * a spoken yes is acceptable, and a `resolution` turns the card into a
 * receipt of how consent was given (buttons collapse into an outcome line).
 */
export function ApprovalCard({
  toolName, input, tier = "act", unverified = false, reason, listening = false, resolution, consequence, onApprove, onDecline,
}: ApprovalCardProps) {
  const action = toolAction(toolName);
  const critical = tier === "critical";
  const escalated = Boolean(reason) && !critical;
  const settled = resolution !== undefined;
  const { rows, more } = approvalRows(input, critical ? null : MAX_VALUE_CHARS);
  const confirmLabel = critical ? `Confirm ${action.request.replace(/^[A-Z]/, (c) => c.toLowerCase())}` : "Send it";
  const declineLabel = critical ? "Cancel" : "No";
  const approveClass = critical ? "fl-btn-ceremony" : escalated ? "fl-btn" : "fl-btn-primary";
  const declineClass = escalated ? "fl-btn fl-btn-primary" : "fl-btn";
  const classes = [
    "fl-approval",
    critical && "fl-approval--ceremony",
    escalated && "fl-approval--escalation",
    listening && !settled && "fl-approval-listening",
    settled && (resolution === "declined" ? "fl-approval-declined" : "fl-approval-approved"),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      role="group"
      aria-label={`Approval request: ${action.question}`}
    >
      <div className="fl-approval-head">
        <span className="fl-approval-ic" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
        </span>
        <div className="fl-approval-heading">
          <div className="fl-approval-eyebrow">
            {/* Tier-generic (live-verification polish 2026-07-04): critical
                covers money AND irreversible/permission-changing tools — the
                spec's Trust-screen phrase, not money-specific copy. */}
            {critical ? "Always needs you" : escalated ? "Hold on — checking with you first" : "Needs your approval"}
            {unverified && <span className="fl-approval-unverified">Unverified tool</span>}
          </div>
          <div className="fl-approval-title">{action.question}</div>
        </div>
      </div>
      {escalated && (
        <div className="fl-approval-reason">Hold on — I stopped to check: {reason}</div>
      )}
      {rows.length > 0 && (
        <dl className="fl-approval-fields">
          {rows.map((row) => (
            <div key={row.label} className="fl-approval-field">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          {more > 0 && <div className="fl-approval-more">+{more} more</div>}
        </dl>
      )}
      {critical && !settled && (
        <div className="fl-approval-consequence">{consequence ?? "This can't be undone."}</div>
      )}
      {settled ? (
        <div className={`fl-approval-outcome ${resolution === "declined" ? "is-declined" : "is-approved"}`} role="status">
          {resolution === "declined"
            ? "Declined"
            : `${action.done} — approved ${resolution === "voice" ? "by voice" : "on screen"} ✓`}
        </div>
      ) : (
        <div className="fl-approval-actions">
          {escalated ? (
            <>
              <button type="button" className={declineClass} onClick={onDecline}>{declineLabel}</button>
              <button type="button" className={`fl-btn ${approveClass}`} onClick={onApprove}>{confirmLabel}</button>
            </>
          ) : (
            <>
              <button type="button" className={`fl-btn ${approveClass}`} onClick={onApprove}>{confirmLabel}</button>
              <button type="button" className={declineClass} onClick={onDecline}>{declineLabel}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
