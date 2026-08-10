/**
 * The value legend a category chart carries (W2 §The Kit).
 *
 * A bar or a slice only shows a PROPORTION: the exact number is nowhere in the
 * document, so a chart-only screen cannot answer "each category's amount
 * matches the tool's number". This prints each category's formatted value as
 * DOM text under the chart, through the same `applyFormat` a DataTable cell
 * uses — one implementation, so a chart and a table can never disagree.
 */
import { applyFormat, type ValueFormat } from "../format.js";
import { font, t } from "../tokens.js";

interface ChartValueItem {
  name: string;
  value: number;
  /** Slice color, where the mark is colored per category (donut). */
  color?: string;
}

export function ChartValues({ items, format = "number" }: { items: ChartValueItem[]; format?: ValueFormat }) {
  return (
    <div
      data-kit="ChartValues"
      style={{ ...font, display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 8, fontSize: "0.9em" }}
    >
      {items.map((item, i) => (
        // Index keys: two rows can honestly carry the same category name.
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {item.color === undefined ? null : (
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flex: "0 0 auto" }} />
          )}
          <span style={{ color: t.muted }}>{item.name}</span>
          <span style={{ color: t.text, fontVariantNumeric: "tabular-nums" }}>{applyFormat(item.value, format) ?? "—"}</span>
        </span>
      ))}
    </div>
  );
}
