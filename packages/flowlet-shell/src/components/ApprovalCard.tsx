import { toolAction } from "./tool-labels";

export interface ApprovalCardProps {
  toolName: string;
  input: unknown;
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

function fieldValue(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/** True for values that carry no information worth confirming. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return true;
  return false;
}

/** Flatten the tool input into readable label/value rows for confirmation. */
function approvalRows(input: unknown): { rows: FieldRow[]; more: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return isEmpty(input) ? { rows: [], more: 0 } : { rows: [{ label: "Input", value: fieldValue(input) }], more: 0 };
  }
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => !isEmpty(v));
  const rows = entries.slice(0, MAX_ROWS).map(([k, v]) => ({ label: fieldLabel(k), value: fieldValue(v) }));
  return { rows, more: Math.max(0, entries.length - MAX_ROWS) };
}

/**
 * The consent moment: the agent wants to run a gated action and is asking
 * first. Reads as a plain-language request — friendly action title + the
 * parameters as labelled fields — never a tool slug and never raw JSON.
 */
export function ApprovalCard({ toolName, input, onApprove, onDecline }: ApprovalCardProps) {
  const title = toolAction(toolName).request;
  const { rows, more } = approvalRows(input);

  return (
    <div className="fl-approval" role="group" aria-label={`Approval request: ${title}`}>
      <div className="fl-approval-head">
        <span className="fl-approval-ic" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
        </span>
        <div className="fl-approval-heading">
          <div className="fl-approval-eyebrow">Needs your approval</div>
          <div className="fl-approval-title">{title}</div>
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
      <div className="fl-approval-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onApprove}>Approve</button>
        <button type="button" className="fl-btn" onClick={onDecline}>Decline</button>
      </div>
    </div>
  );
}
