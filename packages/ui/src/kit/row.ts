/**
 * The row a value component is standing in (2026-08-13, the cell slots).
 *
 * A DataTable cell and a CardList row are rendered once PER RECORD, so a Kit
 * component nested in one cannot be handed its value as a prop: the prop would
 * have to hold a different value in every row, and neither transport this Kit
 * renders through can express that. The wire tree is JSON, and the screen VM
 * serializes a prop function as a `$handler` callback, not as something the
 * table may call while it paints.
 *
 * So the slot binds by NAME instead: the container publishes the record it is
 * rendering, and a value component inside it names the field it wants —
 * `<Money field="amount"/>` — which is the same "a config prop holds a field
 * key" the Kit already speaks in `titleField`, `valueField`, `xKey` and a
 * column's own `key`. Both transports carry a string.
 */
import { createContext, useContext } from "react";

export type KitRow = Record<string, unknown>;

/** The record the nearest DataTable cell / CardList card is rendering. */
export const RowContext = createContext<KitRow | undefined>(undefined);

/** Resolve a dot-path against a record ("client.name"). The ONE resolver: the
 *  table, the card list, the aggregates and every `field` prop read a path the
 *  same way. */
export function readField(row: KitRow | undefined, path: string): unknown {
  if (row === undefined) return undefined;
  return path.split(".").reduce<unknown>(
    (value, key) => (value !== null && typeof value === "object" ? (value as KitRow)[key] : undefined),
    row,
  );
}

/**
 * A value component's own value: the row's field when `field` names one and a
 * row is in scope, and the prop it was passed otherwise. Outside a slot `field`
 * resolves to nothing and the explicit prop still wins, so the same component
 * reads the same either way.
 */
export function useFieldValue<T>(field: string | undefined, fallback: T): T | unknown {
  const row = useContext(RowContext);
  if (field === undefined || row === undefined) return fallback;
  return readField(row, field);
}
