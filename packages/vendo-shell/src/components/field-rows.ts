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

/** The manifest's closed field-format vocabulary (mirrors @vendoai/core's
 *  `FieldFormat` — kept local so the shell's card formatter doesn't couple to
 *  core's export surface; the values are frozen by the manifest schema). */
export type FieldFormat = "cents" | "iso-date" | "iso-datetime" | "percent";

/** Per-field format hints (`{ amount: "cents" }`) from the tool's manifest,
 *  carried alongside the approval so a money/date input renders like the
 *  results do — never guessing a divisor for an un-hinted number. */
export type FieldFormats = Readonly<Record<string, FieldFormat>>;

const currencyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Apply a declared format to a raw input value. Returns a string when the
 *  hint genuinely applies to this value's type, else `undefined` so the
 *  caller falls back to plain humanization — the platform's "never guess"
 *  rule: we only convert when the field was explicitly declared. */
function applyFormat(value: unknown, format: FieldFormat): string | undefined {
  switch (format) {
    case "cents":
      // Integer cents → currency (divide by exactly 100). Only on real numbers.
      return typeof value === "number" && Number.isFinite(value) ? currencyFmt.format(value / 100) : undefined;
    case "percent":
      // Render as-is with a % sign — never rescaled (12.5 → "12.5%").
      return typeof value === "number" && Number.isFinite(value) ? `${value}%` : undefined;
    case "iso-date": {
      // A calendar date — render the named day without a timezone shift.
      if (typeof value !== "string") return undefined;
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
      if (!m) return undefined;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
    case "iso-datetime": {
      if (typeof value !== "string") return undefined;
      const t = Date.parse(value);
      return Number.isNaN(t) ? undefined : new Date(t).toLocaleString("en-US");
    }
    default:
      return undefined;
  }
}

/** "recipient_email" -> "Recipient email". */
export function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function truncate(text: string, maxChars: number | null): string {
  if (maxChars === null || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** `maxChars: null` disables truncation entirely — critical cards never
 *  truncate material fields (spec §3 Moment 6, §4.5 "untruncated").
 *
 *  Object/array values render as compact `Key: value` lines (one per entry,
 *  depth 1 — live-verification polish 2026-07-04: the cards were showing raw
 *  JSON like `{"body":"Hi Marisol…`). Nested values beyond depth 1 fall back
 *  to JSON; truncation applies per line so a long field can't hide its
 *  siblings. The rows render with `white-space: pre-line`. */
export function fieldValue(value: unknown, maxChars: number | null, depth = 0): string {
  if (typeof value === "string") return truncate(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth === 0 && value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map((v) => truncate(fieldValue(v, maxChars, 1), maxChars)).join("\n");
    }
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => !isEmpty(v))
      .map(([k, v]) => `${fieldLabel(k)}: ${fieldValue(v, maxChars, 1)}`)
      .join("\n");
  }
  return truncate(JSON.stringify(value), maxChars);
}

/** True for values that carry no information worth confirming. */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return true;
  return false;
}

/** Flatten the tool input into readable label/value rows for confirmation.
 *  `maxChars: null` is the SAME critical signal `fieldValue` uses — a
 *  critical card never truncates material fields, so it must never HIDE one
 *  behind a "+N more" row cap either (finding 2: a critical payload can carry
 *  more than MAX_ROWS fields and every one of them is material). Only an
 *  act-tier card (a finite `maxChars`) caps at MAX_ROWS. */
export function approvalRows(
  input: unknown,
  maxChars: number | null,
  formats?: FieldFormats,
): { rows: FieldRow[]; more: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return isEmpty(input) ? { rows: [], more: 0 } : { rows: [{ label: "Input", value: fieldValue(input, maxChars) }], more: 0 };
  }
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => !isEmpty(v));
  const capped = maxChars === null ? entries : entries.slice(0, MAX_ROWS);
  const rows = capped.map(([k, v]) => {
    // Honor a declared format hint (cents/date/percent) so a money/date input
    // reads like the results do; fall back to plain humanization otherwise.
    const formatted = formats?.[k] !== undefined ? applyFormat(v, formats[k]!) : undefined;
    return { label: fieldLabel(k), value: formatted ?? fieldValue(v, maxChars) };
  });
  return { rows, more: maxChars === null ? 0 : Math.max(0, entries.length - MAX_ROWS) };
}
