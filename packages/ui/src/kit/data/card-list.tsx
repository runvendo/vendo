/** CardList — one branded card per record, semantically formatted (W2 §The Kit). */
import { applyFormat, type ValueFormat } from "../format.js";
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
}

function resolve(row: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), row);
}

export function CardList({ items, titleField, badgeField, fields = [], columns, emptyState = "No items" }: CardListProps) {
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
