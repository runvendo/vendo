/**
 * Internal: the fn: reference rules the tree validator enforces on the wire —
 * 01 §8 grammar on TreeQuery.tool and action names. Not exported from the
 * package root.
 */

/** 01-core §8: `fn:<name>` with `<name>` matching this grammar. */
export const FN_REFERENCE_PATTERN = /^fn:[A-Za-z_][A-Za-z0-9_-]*$/;

/** The first grammar-violating `fn:` action reference in a props value, or
 *  null. HOT wire path: validateTree runs on every render, so this walk is
 *  allocation-free (no collected arrays, no Object.values copies) — the
 *  tree-render perf budget is measured with it inline. */
export function findInvalidActionReference(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const invalid = findInvalidActionReference(item);
      if (invalid !== null) return invalid;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const action = record.action;
  if (typeof action === "string" && action.startsWith("fn:") && !FN_REFERENCE_PATTERN.test(action)) {
    return action;
  }
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const invalid = findInvalidActionReference(record[key]);
    if (invalid !== null) return invalid;
  }
  return null;
}
