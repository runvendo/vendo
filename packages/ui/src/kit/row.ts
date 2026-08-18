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
import type { SemanticToken } from "@vendoai/core";
import { createContext, useContext } from "react";
import type { ValueFormat } from "./format.js";

export type KitRow = Record<string, unknown>;

/**
 * A field description, as every container that reads records shares it: a
 * DataTable column, a CardList field, a KeyValue row.
 *
 * `semantic` is the HOST's own word for what the field is, copied verbatim off
 * the tool's shape card (`compute_cost: number:money.cents`). It is the ONLY
 * thing that changes how a field reads: undeclared and unformatted, a field
 * prints exactly what the record holds. Nothing here reads a name or a value
 * shape for what a field might be — a guess that is right nine times still
 * shows a wrong figure the tenth, and nobody asked for it.
 */
export interface KitFieldDescriptor {
  key: string;
  format?: ValueFormat;
  semantic?: SemanticToken;
}

/**
 * The value tier's token for a declared semantic — what a field READS AS.
 *
 * A date is `datetime` whichever way it was declared, because that token
 * already refines itself: `formatDateTime` shows a date-only value as the day
 * alone rather than stamping "12:00 AM" on it (format.ts).
 *
 * Two tokens map to nothing, and print the raw figure rather than a wrong one.
 * `percent.0-100` — the tier's `percent` takes a RATIO, so `42` would render as
 * "4200%". `id` — an id is a handle a screen passes back to a tool, and has no
 * presentation of its own; a host that wants one READ says `code`.
 */
const SEMANTIC_FORMAT: Partial<Record<SemanticToken, ValueFormat>> = {
  "money.cents": "money",
  "money.dollars": "money",
  "date.iso": "datetime",
  "date.epoch": "datetime",
  "percent.ratio": "percent",
  code: "code",
};

/** The format a HOST-DECLARED field reads in, or `undefined` when the host said
 *  nothing this tier can act on. */
export const semanticFormat = (semantic: SemanticToken | undefined): ValueFormat | undefined =>
  semantic === undefined ? undefined : SEMANTIC_FORMAT[semantic];

/**
 * The value a read site SHOWS, in the units it shows it in — the one place a
 * field's units are settled, for the cell, the sort and the filters alike.
 *
 * A field the host DECLARED `money.cents` is divided by 100 here. This is the
 * one conversion in the Kit, and it happens only on that instruction:
 * `formatMoney` still never converts (format.ts), and a field descriptor IS the
 * read site that law points at — the model cannot divide inside a column key.
 * An undeclared field is never divided, whatever it is called. Dividing is
 * monotone, so sorting cannot change order.
 *
 * Only a READ site. A write tool's arguments are assembled off the raw record
 * (`RowContext` publishes `row.original`), so nothing converted here can reach
 * one — a screen that sent `12.10` where the host wanted `1210` would be the
 * same 100× defect pointing the other way.
 */
export function readValue(record: KitRow | undefined, field: KitFieldDescriptor): unknown {
  const value = readField(record, field.key);
  return typeof value === "number" && field.semantic === "money.cents" ? value / 100 : value;
}

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
