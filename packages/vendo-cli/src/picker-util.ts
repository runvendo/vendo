/**
 * Small presentation helpers shared by the two interactive pickers (the
 * component catalog picker in components/extract-components.ts and the remix
 * picker in remix/step.ts). Both label rows by a symbol name, disambiguate
 * duplicate names with the file path, and cap the inline hint — keep that
 * behavior in ONE place so the two pickers stay visually identical.
 */

/** Picker hints render inline next to the checkbox — keep them one short line. */
export const MAX_HINT_CHARS = 72;

/** Truncate a reason to a single inline hint line (ellipsis when over the cap). */
export function truncateHint(reason: string): string {
  return reason.length > MAX_HINT_CHARS ? `${reason.slice(0, MAX_HINT_CHARS - 1).trimEnd()}…` : reason;
}

/**
 * Build a label function over `items`: a bare `name` when unique, `name (path)`
 * when the same name appears more than once. Keeps identical names from
 * rendering identical (ambiguous) picker rows.
 */
export function disambiguatedLabels<T>(
  items: readonly T[],
  nameOf: (t: T) => string,
  pathOf: (t: T) => string,
): (t: T) => string {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(nameOf(it), (counts.get(nameOf(it)) ?? 0) + 1);
  return (t) => ((counts.get(nameOf(t)) ?? 0) > 1 ? `${nameOf(t)} (${pathOf(t)})` : nameOf(t));
}
