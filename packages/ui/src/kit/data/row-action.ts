/**
 * A per-record action's arguments (DataTable/CardList `onRowAction`). The row
 * the button sits on is the only place the record's identity exists at press
 * time, so the Kit reads the named fields off that row and hands them to the
 * bound action — without this, a bound action can only ever send what was
 * authored for the whole screen, which is why a `cancel_transfer` press
 * arrived with no `id`.
 *
 * Absent fields are left OUT rather than sent as null: a tool that requires the
 * field should hear that it is missing, not receive a null for it.
 */
export type RowActionVariant = "primary" | "secondary" | "danger";

const resolvePath = (row: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
    row,
  );

export function rowActionArguments(
  row: Record<string, unknown>,
  keys: string[] | undefined,
): Record<string, unknown> | undefined {
  const entries = (keys ?? ["id"])
    .map((key) => [key, resolvePath(row, key)] as const)
    .filter(([, value]) => value !== undefined && value !== null);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
