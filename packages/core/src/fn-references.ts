/**
 * Internal: the fn: reference rules shared by the tree validator (wire — 01
 * §8 grammar on TreeQuery.tool and action names) and the app-document
 * validator (at rest — grammar plus the machine-presence rule, which only the
 * document can know). Not exported from the package root.
 */

/** 01-core §8: `fn:<name>` with `<name>` matching this grammar. */
export const FN_REFERENCE_PATTERN = /^fn:[A-Za-z_][A-Za-z0-9_-]*$/;

/** Walk a props value collecting every `{ action: "fn:..." }` reference — the
 *  renderer's dispatch chokepoint reads action names from anywhere in props,
 *  so validation must find them anywhere too. Cold path (app documents at
 *  rest); the wire path uses {@link findInvalidActionReference}. */
export function collectActionReferences(value: unknown, references: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectActionReferences(item, references);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.action === "string" && record.action.startsWith("fn:")) {
    references.push(record.action);
  }
  for (const nested of Object.values(record)) collectActionReferences(nested, references);
}

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
