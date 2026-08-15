/** KeyValue — one record's fields as two-column label/value rows (W2 §The Kit). */
import { Fragment, type ReactNode } from "react";
import { applyFormat, type ValueFormat } from "../format.js";
import { readField, RowContext } from "../row.js";
import { font, hairline, microLabel, numeric, t } from "../tokens.js";
import { humanizeEnum } from "../values.js";

export interface KeyValueItem {
  /** Field key; supports dot-paths ("client.name"). */
  key: string;
  /** Row label; defaults to a humanized last path segment. */
  label?: string;
  /** Value-tier format applied to the value. */
  format?: ValueFormat;
  /** Kit elements rendered as this row's VALUE (the label stays), with the
   *  record published on `RowContext` so the components inside name their
   *  field — the DataTable cell contract, for a single record. */
  cell?: ReactNode;
}

export interface KeyValueProps {
  /** The record being described, from a tool call. */
  record: Record<string, unknown>;
  /** The fields to show, in order. */
  items: KeyValueItem[];
  /** Hairline rule between rows. */
  dividers?: boolean;
}

export function KeyValue({ record, items = [], dividers = false }: KeyValueProps) {
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
                {item.cell ?? applyFormat(readField(record, item.key), item.format ?? "text") ?? (
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
