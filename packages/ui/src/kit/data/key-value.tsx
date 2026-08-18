/** KeyValue — one record's fields as two-column label/value rows (W2 §The Kit). */
import type { SemanticToken } from "@vendoai/core";
import { Fragment, type ReactNode } from "react";
import { applyFormat, type ValueFormat } from "../format.js";
import { fieldItems, readValue, RowContext, semanticFormat } from "../row.js";
import { font, hairline, microLabel, mono, numeric, t, type KitStyled } from "../tokens.js";
import { humanizeEnum } from "../values.js";

export interface KeyValueItem {
  /** Field key; supports dot-paths ("client.name"). */
  key: string;
  /** Row label; defaults to a humanized last path segment. */
  label?: string;
  /** Value-tier format applied to the value. */
  format?: ValueFormat;
  /** What the HOST says this field is, copied off its tool's shape card
   *  (`money.cents`, `date.iso`, `code`) — it decides the format and the units
   *  this row reads in. */
  semantic?: SemanticToken;
  /** Kit elements rendered as this row's VALUE (the label stays), with the
   *  record published on `RowContext` so the components inside name their
   *  field — the DataTable cell contract, for a single record. */
  cell?: ReactNode;
}

export interface KeyValueProps extends KitStyled {
  /** The record being described, from a tool call. */
  record: Record<string, unknown>;
  /** The fields to show, in order; a bare string is its key. Omitted, they are
   *  the record's own keys. */
  items?: Array<KeyValueItem | string>;
  /** Hairline rule between rows. */
  dividers?: boolean;
}

export function KeyValue({ record, items: rawItems, dividers = false, style }: KeyValueProps) {
  // No `items` is "describe this record" — the same default DataTable's columns
  // have, for the one-record shape.
  const items = fieldItems<KeyValueItem>(rawItems ?? Object.keys(record ?? {}));
  return (
    // One provider for the whole list — a row's slot reads its field off it.
    <RowContext.Provider value={record}>
      <dl
        data-kit="KeyValue"
        style={{
          ...font,
          display: "grid",
          gridTemplateColumns: "minmax(0, auto) minmax(0, 1fr)",
          alignItems: "baseline",
          columnGap: "var(--vendo-density-content-gap, 10px)",
          rowGap: "var(--vendo-density-field-gap, 6px)",
          margin: 0,
          ...style,
        }}
      >
        {items.map((item, index) => {
          // The host's declaration fills the format the model left off, and
          // `readValue` reads the field in the units it declared.
          const format = item.format ?? semanticFormat(item.semantic) ?? "text";
          const edge = !dividers || index === items.length - 1
            ? {}
            : {
                borderBottom: hairline,
                paddingBottom: "var(--vendo-density-field-gap, 6px)",
              };
          return (
            <Fragment key={item.key}>
              <dt style={{ ...microLabel, ...edge, whiteSpace: "nowrap" }}>
                {item.label ?? humanizeEnum(item.key.split(".").pop() ?? item.key)}
              </dt>
              <dd
                style={{
                  ...numeric,
                  // The face is the row's when the row prints a value; a `cell`
                  // slot brings components that carry their own.
                  ...(item.cell === undefined && format === "code" ? mono : {}),
                  ...edge,
                  margin: 0,
                  justifySelf: "end",
                  textAlign: "right",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                {item.cell ?? applyFormat(readValue(record, { ...item, format }), format) ?? (
                  <span style={{ color: t.muted }}>—</span>
                )}
              </dd>
            </Fragment>
          );
        })}
      </dl>
    </RowContext.Provider>
  );
}
