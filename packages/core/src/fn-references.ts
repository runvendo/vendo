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
 *  so validation must find them anywhere too. */
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
