/** KeyValue — one record's fields as two-column label/value rows (W2 §The Kit). */
import { Fragment, type ReactNode } from "react";
import { applyFormat } from "../format.js";
import { fieldItems, readField } from "../row.js";
import { font, hairline, microLabel, numeric, t, type KitStyled } from "../tokens.js";
import { humanizeEnum } from "../values.js";

export interface KeyValueItem {
  /** Field key; supports dot-paths ("client.name"). */
  key: string;
  /** Row label; defaults to a humanized last path segment. */
  label?: string;
  /** Kit elements rendered as this row's VALUE (the label stays) — the DataTable
   *  cell contract, for a single record. Written as a function it is called once,
   *  with the record, so ONE element arrives and there is nothing to match. */
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
                ...edge,
                margin: 0,
                justifySelf: "end",
                textAlign: "right",
                minWidth: 0,
                overflowWrap: "anywhere",
              }}
            >
              {item.cell ?? applyFormat(readField(record, item.key), "text") ?? <span style={{ color: t.muted }}>—</span>}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
