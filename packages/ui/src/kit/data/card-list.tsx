/** CardList — one branded card per record, semantically formatted (W2 §The Kit). */
import { applyFormat, type ValueFormat } from "../format.js";
import { Button } from "../forms/button.js";
import { font, t } from "../tokens.js";
import { EnumBadge } from "../values.js";

export interface CardField {
  key: string;
  label?: string;
  format?: ValueFormat;
}

export interface CardListProps {
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
  /** One-line rows instead of cards — the dense shape at phone width. */
  layout?: "cards" | "rows";
  /** Bound host-tool action for each row's trailing control (rows layout). */
  onRowAction?: (args?: Record<string, unknown>) => void;
  /** Label of that control. */
  rowActionLabel?: string;
  /** Row fields sent as the action's arguments. */
  rowActionArgs?: string[];
  /** Emphasis of that control. */
  rowActionVariant?: "secondary" | "danger";
}

function resolve(row: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), row);
}

const isNumericField = (f: CardField): boolean => f.format === "money" || f.format === "number" || f.format === "percent";

export function CardList({
  items: rawItems,
  titleField,
  badgeField,
  fields = [],
  columns,
  emptyState = "No items",
  layout = "cards",
  onRowAction,
  rowActionLabel = "Open",
  rowActionArgs = ["id"],
  rowActionVariant = "secondary",
}: CardListProps) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (items.length === 0) {
    return (
      <div
        data-kit="CardList"
        style={{
          ...font,
          color: t.muted,
          textAlign: "center",
          border: `1px dashed ${t.border}`,
          borderRadius: t.radiusMedium,
          padding: "calc(var(--vendo-font-size, 15px) * 1.6)",
        }}
      >
        {emptyState}
      </div>
    );
  }
  if (layout === "rows") {
    // One line per record: the row IS the label, so a field carries no label
    // text. Amounts sit last-but-one so the column lines up across rows even
    // when badge widths differ.
    return (
      <div
        data-kit="CardList"
        style={{ ...font, border: `1px solid ${t.border}`, borderRadius: t.radiusMedium, background: t.surface, overflow: "hidden" }}
      >
        {items.map((item, index) => {
          const badge = badgeField ? resolve(item, badgeField) : undefined;
          const cell = (f: CardField): string => applyFormat(resolve(item, f.key), f.format ?? "text") ?? "—";
          return (
            <div
              key={String(resolve(item, "id") ?? index)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                borderTop: index === 0 ? 0 : `1px solid ${t.border}`,
                padding: "var(--vendo-density-table-padding, 10px 12px)",
              }}
            >
              <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {titleField ? String(resolve(item, titleField) ?? "—") : ""}
              </span>
              {fields.filter((f) => !isNumericField(f)).map((f) => (
                <span key={f.key} style={{ color: t.muted, whiteSpace: "nowrap" }}>{cell(f)}</span>
              ))}
              {badge !== undefined && badge !== null && badge !== "" ? <EnumBadge value={String(badge)} /> : null}
              {fields.filter(isNumericField).map((f) => (
                <span key={f.key} style={{ color: t.text, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{cell(f)}</span>
              ))}
              {onRowAction ? (
                <Button
                  label={rowActionLabel}
                  variant={rowActionVariant}
                  onClick={() => onRowAction(Object.fromEntries(rowActionArgs.map((k) => [k, resolve(item, k)])))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }
  const gridTemplate = columns
    ? `repeat(${Math.max(1, Math.floor(columns))}, minmax(0, 1fr))`
    : "repeat(auto-fill, minmax(220px, 1fr))";
  return (
    <div
      data-kit="CardList"
      style={{ display: "grid", gridTemplateColumns: gridTemplate, gap: "var(--vendo-density-content-gap, 10px)" }}
    >
      {items.map((item, index) => {
        const badge = badgeField ? resolve(item, badgeField) : undefined;
        return (
          <article
            key={String(resolve(item, "id") ?? index)}
            style={{
              ...font,
              display: "flex",
              flexDirection: "column",
              gap: "var(--vendo-density-field-gap, 6px)",
              border: `1px solid ${t.border}`,
              borderRadius: t.radiusLarge,
              background: t.surface,
              boxShadow: `0 4px 20px color-mix(in srgb, ${t.text} 5%, transparent)`,
              padding: "var(--vendo-density-card-padding, 16px)",
            }}
          >
            {(titleField || badge !== undefined) && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                {titleField ? (
                  <span style={{ fontFamily: t.headingFamily, fontWeight: 650, letterSpacing: "-0.015em" }}>
                    {String(resolve(item, titleField) ?? "—")}
                  </span>
                ) : <span />}
                {badge !== undefined && badge !== null && badge !== "" ? (
                  <EnumBadge value={String(badge)} />
                ) : null}
              </div>
            )}
            {fields.map((f) => {
              const formatted = applyFormat(resolve(item, f.key), f.format ?? "text");
              return (
                <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "0.92em" }}>
                  <span style={{ color: t.muted }}>{f.label ?? f.key}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatted ?? "—"}</span>
                </div>
              );
            })}
          </article>
        );
      })}
    </div>
  );
}
