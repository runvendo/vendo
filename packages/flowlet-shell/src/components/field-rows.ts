/**
 * Flattens a tool call's `input` object into readable label/value rows.
 * Shared by `ApprovalCard` (the consent moment) and `ActivityStep` (the
 * settled receipt's expandable detail — ENG-193 §3 Moment 2) so a receipt
 * reads exactly like the approval card that (maybe) preceded it.
 */
const MAX_ROWS = 8;

export interface FieldRow {
  label: string;
  value: string;
}

/** "recipient_email" -> "Recipient email". */
export function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `maxChars: null` disables truncation entirely — critical cards never
 *  truncate material fields (spec §3 Moment 6, §4.5 "untruncated"). */
export function fieldValue(value: unknown, maxChars: number | null): string {
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
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return true;
  return false;
}

/** Flatten the tool input into readable label/value rows for confirmation. */
export function approvalRows(input: unknown, maxChars: number | null): { rows: FieldRow[]; more: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return isEmpty(input) ? { rows: [], more: 0 } : { rows: [{ label: "Input", value: fieldValue(input, maxChars) }], more: 0 };
  }
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => !isEmpty(v));
  const rows = entries.slice(0, MAX_ROWS).map(([k, v]) => ({ label: fieldLabel(k), value: fieldValue(v, maxChars) }));
  return { rows, more: Math.max(0, entries.length - MAX_ROWS) };
}
