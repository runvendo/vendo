/** DonutChart — recharts Pie internals, data props only (W2 §The Kit). */
import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import { isRenderableNumber, applyFormat, type ValueFormat } from "../format.js";
import { font, hairline, numeric, seriesColor, t } from "../tokens.js";
import { ChartEmpty, ChartFrame } from "./sanitize.js";

export interface DonutChartProps {
  data: Array<Record<string, unknown>>;
  /** Slice-label field. */
  categoryKey: string;
  /** Slice-value field. */
  valueKey: string;
  /** Value-tier format for tooltips. */
  format?: ValueFormat;
  /** false renders a full pie. */
  donut?: boolean;
  /** Name + value under the ring. On by default. */
  legend?: boolean;
  height?: number;
  emptyState?: string;
}

export function DonutChart({
  data,
  categoryKey,
  valueKey,
  format = "number",
  donut = true,
  legend = true,
  height = 220,
  emptyState = "No data to chart",
}: DonutChartProps) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined),
  // the same guard the other Kit charts get via sanitizeSeries.
  const slices = (Array.isArray(data) ? data : [])
    .map((row) => ({ name: String(row[categoryKey] ?? ""), value: row[valueKey] }))
    .filter((s) => isRenderableNumber(s.value) && (s.value as number) > 0) as Array<{ name: string; value: number }>;
  if (slices.length === 0) {
    return <ChartEmpty height={height}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div
      data-kit="DonutChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)" }}
    >
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <RPieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={donut ? "58%" : 0}
              outerRadius="82%"
              paddingAngle={donut ? 2 : 0}
              stroke={t.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: t.radiusSmall, border: hairline, background: t.surface, color: t.text, fontSize: 12, boxShadow: t.shadowSmall }} />
          </RPieChart>
        </ResponsiveContainer>
      </ChartFrame>
      {/* An unlabelled ring says NOTHING in a screenshot — a hover tooltip is
          not a label (genbench spend-overview, 2026-08-11). Every slice is
          named and valued on the page itself. */}
      {legend ? (
        <ul
          data-kit="DonutLegend"
          style={{
            ...font,
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--vendo-density-inline-gap, 7px) var(--vendo-density-content-gap, 10px)",
            listStyle: "none",
            margin: 0,
            padding: 0,
            fontSize: "0.85em",
          }}
        >
          {slices.map((slice, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, flexShrink: 0, borderRadius: 999, background: seriesColor(i) }}
              />
              {/* The name as the DATA spells it, which is what the slice's own
                  tooltip shows: humanizing lowercased proper nouns ("ACME Corp"
                  → "Acme corp") and made the two disagree. */}
              <span>{slice.name}</span>
              <span style={{ ...numeric, color: t.muted }}>{fmt(slice.value)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
