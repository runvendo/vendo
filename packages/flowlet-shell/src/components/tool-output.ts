/**
 * Best-effort, defensive summaries of a tool's output for the activity panel.
 * Tool output is arbitrary `unknown`, so these never assume a shape — they show
 * a compact count and a few primitive rows, and bail to nothing when there's
 * nothing legible to show.
 */

export interface PeekRow {
  label: string;
  value: string;
}

const MAX_ROWS = 4;

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * True when a settled `output-available` tool part's output is actually the
 * runtime's `policyDenied(...)` payload (`@flowlet/runtime`'s errors.ts,
 * `{ code: "policy_denied", tool, rule }`) — a SERVER tool whose `execute`
 * short-circuited a deny returns this as an ordinary successful result (the
 * SDK never sees a throw), so `state` alone reads as a success. Finding 1:
 * without this check the shell rendered a ✓ receipt for a call that was
 * actually blocked by the user's own policy.
 */
export function isPolicyDenied(output: unknown): boolean {
  return (
    output != null &&
    typeof output === "object" &&
    (output as { code?: unknown }).code === "policy_denied"
  );
}

/** A short right-aligned summary for the step row, e.g. "2 results". */
export function stepSummary(output: unknown): string | undefined {
  if (Array.isArray(output)) {
    return `${output.length} ${output.length === 1 ? "result" : "results"}`;
  }
  return undefined;
}

/** Try to find a human-ish label field on a record. */
function rowLabel(record: Record<string, unknown>, fallback: string): string {
  for (const key of ["name", "title", "label", "merchant", "subject", "id"]) {
    const v = record[key];
    if (isPrimitive(v)) return String(v);
  }
  return fallback;
}

/** Try to find a value-ish field on a record. */
function rowValue(record: Record<string, unknown>): string {
  for (const key of ["amount", "value", "total", "count", "status", "date"]) {
    const v = record[key];
    if (isPrimitive(v)) return String(v);
  }
  // Otherwise the first primitive that isn't the label.
  for (const v of Object.values(record)) {
    if (isPrimitive(v)) return String(v);
  }
  return "";
}

/** Compact rows for the expanded result peek; empty when nothing is legible. */
export function peekRows(output: unknown): PeekRow[] {
  if (Array.isArray(output)) {
    return output.slice(0, MAX_ROWS).map((entry, i) => {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return { label: rowLabel(record, `Item ${i + 1}`), value: rowValue(record) };
      }
      return { label: `Item ${i + 1}`, value: isPrimitive(entry) ? String(entry) : "" };
    });
  }
  if (output && typeof output === "object") {
    const entries = Object.entries(output as Record<string, unknown>).filter(([, v]) => isPrimitive(v));
    return entries.slice(0, MAX_ROWS).map(([label, value]) => ({ label, value: String(value) }));
  }
  return [];
}
