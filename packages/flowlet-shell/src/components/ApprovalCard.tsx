import { toolAction } from "./tool-labels";

export interface ApprovalCardProps {
  toolName: string;
  input: unknown;
  /** ENG-193 §4.1 — from the sibling data-consent part. Defaults to "act". */
  tier?: "act" | "critical";
  /** Yousef ruling: unknown-annotation tools land in act but are flagged. */
  unverified?: boolean;
  onApprove: () => void;
  onDecline: () => void;
}

const MAX_ROWS = 8;
const MAX_VALUE_CHARS = 160;

interface FieldRow {
  label: string;
  value: string;
}

/** "recipient_email" -> "Recipient email". */
function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `maxChars: null` disables truncation entirely — critical cards never
 *  truncate material fields (spec §3 Moment 6, §4.5 "untruncated"). */
function fieldValue(value: unknown, maxChars: number | null): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  if (maxChars === null || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** True for values that carry no information worth confirming. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return true;
  return false;
}

/** Flatten the tool input into readable label/value rows for confirmation. */
function approvalRows(input: unknown, maxChars: number | null): { rows: FieldRow[]; more: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return isEmpty(input) ? { rows: [], more: 0 } : { rows: [{ label: "Input", value: fieldValue(input, maxChars) }], more: 0 };
  }
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => !isEmpty(v));
  const rows = entries.slice(0, MAX_ROWS).map(([k, v]) => ({ label: fieldLabel(k), value: fieldValue(v, maxChars) }));
  return { rows, more: Math.max(0, entries.length - MAX_ROWS) };
}

/**
 * The consent moment (spec §3 Moments 3 & 6): a plain yes/no card for an
 * act-tier action, or the ceremony variant for critical (money/irreversible)
 * actions — amber register, a named confirm button (never generic
 * "Approve"), a fixed consequence line, and NO truncation of material fields.
 */
export function ApprovalCard({ toolName, input, tier = "act", unverified = false, onApprove, onDecline }: ApprovalCardProps) {
  const action = toolAction(toolName);
  const critical = tier === "critical";
  const { rows, more } = approvalRows(input, critical ? null : MAX_VALUE_CHARS);
  const confirmLabel = critical ? `Confirm ${action.request.replace(/^[A-Z]/, (c) => c.toLowerCase())}` : "Send it";
  const declineLabel = critical ? "Cancel" : "No";

  return (
    <div
      className={`fl-approval${critical ? " fl-approval--ceremony" : ""}`}
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
            {critical ? "Money — always needs you" : "Needs your approval"}
            {unverified && <span className="fl-approval-unverified">Unverified tool</span>}
          </div>
          <div className="fl-approval-title">{action.question}</div>
        </div>
      </div>
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
      {critical && <div className="fl-approval-consequence">This can&apos;t be undone.</div>}
      <div className="fl-approval-actions">
        <button
          type="button"
          className={`fl-btn ${critical ? "fl-btn-ceremony" : "fl-btn-primary"}`}
          onClick={onApprove}
        >
          {confirmLabel}
        </button>
        <button type="button" className="fl-btn" onClick={onDecline}>{declineLabel}</button>
      </div>
    </div>
  );
}
