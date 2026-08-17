/** CardList — one branded card per record, semantically formatted (W2 §The Kit). */
import type { ReactNode } from "react";
import { EmptyOrForming } from "../../tree/forming-skeleton.js";
import { applyFormat, type ValueFormat } from "../format.js";
import { readField, RowContext } from "../row.js";
import { densityVars, font, hairline, numeric, t, type KitDensity, type KitStyled } from "../tokens.js";
import { EnumBadge } from "../values.js";

export interface CardField {
  key: string;
  label?: string;
  format?: ValueFormat;
  /** Kit elements rendered as this field's VALUE for THIS item (the label
   *  stays); the components inside name their field. */
  cell?: ReactNode;
}

export interface CardListProps extends KitStyled {
  /** Items from a tool call. */
  items: Array<Record<string, unknown>>;
  /** Field used as each card's title. */
  titleField?: string;
  /** Optional field rendered as a status pill (EnumBadge). */
  badgeField?: string;
  /** Fields shown as label/value rows. */
  fields?: CardField[];
  /** Columns of cards (defaults to a responsive auto-fit grid). */
  columns?: number;
  /** Text shown when there are no items. */
  emptyState?: string;
  /** Kit elements shown in place of `emptyState` when there are no items. */
  empty?: ReactNode;
  /** Kit elements in a row above the cards — what the list as a whole does. */
  actions?: ReactNode;
  /** Spacing scale for this list's subtree. */
  density?: KitDensity;
}

export function CardList({ items: rawItems, titleField, badgeField, fields = [], columns, emptyState = "No items", empty, actions, density, style }: CardListProps) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (items.length === 0) {
    // The slot replaces the dashed box, not its TEXT: what goes in one is an
    // EmptyState, which draws that same frame itself — nested, it read as a
    // box inside a box.
    return empty !== undefined ? <div data-kit="CardList" style={style}><EmptyOrForming>{empty}</EmptyOrForming></div> : (
      <div
        data-kit="CardList"
        style={{
          ...font,
          color: t.muted,
          textAlign: "center",
          border: `${t.borderWidth} dashed ${t.border}`,
          borderRadius: t.radiusMedium,
          padding: "calc(var(--vendo-font-size, 15px) * 1.6)",
          ...style,
        }}
      >
        <EmptyOrForming>{emptyState}</EmptyOrForming>
      </div>
    );
  }
  const gridTemplate = columns
    ? `repeat(${Math.max(1, Math.floor(columns))}, minmax(0, 1fr))`
    : "repeat(auto-fill, minmax(220px, 1fr))";
  const grid = (
    <div
      data-kit="CardList"
      style={{ ...densityVars(density), display: "grid", gridTemplateColumns: gridTemplate, gap: "var(--vendo-density-content-gap, 10px)", ...style }}
    >
      {items.map((item, index) => {
        const badge = badgeField ? readField(item, badgeField) : undefined;
        return (
          // One provider per card — a field slot's components read their field
          // off it, exactly as a table cell's do.
          <RowContext.Provider key={String(readField(item, "id") ?? index)} value={item}>
            <article
              style={{
                ...font,
                display: "flex",
                flexDirection: "column",
                gap: "var(--vendo-density-field-gap, 6px)",
                border: hairline,
                borderRadius: t.radiusLarge,
                background: t.surface,
                padding: "var(--vendo-density-card-padding, 16px)",
              }}
            >
              {(titleField || badge !== undefined) && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  {titleField ? (
                    <span style={{ fontFamily: t.headingFamily, fontWeight: t.weightEmphasis, lineHeight: t.lineHeightHeading }}>
                      {String(readField(item, titleField) ?? "—")}
                    </span>
                  ) : <span />}
                  {badge !== undefined && badge !== null && badge !== "" ? (
                    <EnumBadge value={String(badge)} />
                  ) : null}
                </div>
              )}
              {fields.map((f) => (
                <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "0.92em" }}>
                  <span style={{ color: t.muted }}>{f.label ?? f.key}</span>
                  {f.cell ?? (
                    <span style={numeric}>
                      {applyFormat(readField(item, f.key), f.format ?? "text") ?? "—"}
                    </span>
                  )}
                </div>
              ))}
            </article>
          </RowContext.Provider>
        );
      })}
    </div>
  );
  // The grid IS the list when nothing acts on it — the column above only exists
  // to carry the actions row.
  return actions === undefined ? grid : (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-content-gap, 10px)" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--vendo-density-inline-gap, 7px)" }}>{actions}</div>
      {grid}
    </div>
  );
}
