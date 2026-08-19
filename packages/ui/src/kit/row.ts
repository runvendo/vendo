/**
 * Reading a record, and picking ONE row's element out of a per-row slot.
 *
 * A DataTable cell and a CardList card are painted once PER RECORD, and the slot
 * that fills one is written as a function of the row — `cell: (row) =>
 * <Text>{(row.amount_cents / 100).toLocaleString("en-US", { style: "currency",
 * currency: "USD" })}</Text>` — so a per-row slot binds by CLOSURE: the
 * formatting, the composition and that row's own handler all live where the row
 * is in scope. The screen VM calls the function once per row and hands the
 * component a LIST of elements, one per row, in the order of the rows prop
 * (apps `contract/kit/specs.ts` KIT_SLOT_PROPS).
 *
 * What is left here is what every container that reads records shares: the ONE
 * dot-path resolver, the bare-KEY shorthand each list prop takes, and the pick
 * that turns that list back into this row's element.
 */
import type { ReactNode } from "react";

export type KitRow = Record<string, unknown>;

/** Resolve a dot-path against a record ("client.name"). The ONE resolver: the
 *  table, the card list, the calendar and the aggregates read a path the same
 *  way. */
export function readField(row: KitRow | undefined, path: string): unknown {
  if (row === undefined) return undefined;
  return path.split(".").reduce<unknown>(
    (value, key) => (value !== null && typeof value === "object" ? (value as KitRow)[key] : undefined),
    row,
  );
}

/**
 * The field descriptions a container was given, with a bare KEY read as the
 * description it stands for.
 *
 * `items={["client.name", "amount"]}` is the shape a screen reaches for when it
 * only wants the fields named, and it is the shape `Select.options` has always
 * taken (`forms/options.ts` — a raw string is a choice). A string can only mean
 * the key: `label` already defaults from it and the value prints as it stands,
 * so the shorthand has no second reading to get wrong. Normalizing HERE is what
 * keeps one component from teaching it and its two siblings refusing it.
 *
 * Also the fail-SOFT gate every list prop needs (W3): a failed query resolves to
 * undefined, and a table asked to map over it would crash instead of painting
 * its empty state.
 */
export const fieldItems = <T extends { key?: string }>(items: ReadonlyArray<T | string> | undefined): T[] =>
  (Array.isArray(items) ? items : []).map((item) => (typeof item === "string" ? { key: item } : item) as T);

/**
 * ONE row's element out of a per-row slot: the list's own entry where the slot
 * was written as a function of the row, and the same element for every row where
 * a stored screen or a hand-written tree holds a single one.
 *
 * `index` is the row's place in the ROWS PROP, because that is the order the VM
 * emitted in — never the place the row is painted in, which a sort can move. An
 * index nothing matches picks nothing.
 */
export const rowSlot = (slot: ReactNode | readonly ReactNode[], index: number): ReactNode =>
  Array.isArray(slot) ? (slot as readonly ReactNode[])[index] : slot;
