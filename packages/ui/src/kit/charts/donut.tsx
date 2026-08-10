/** DonutChart — recharts Pie internals, data props only (W2 §The Kit). */
import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import { isRenderableNumber, applyFormat, type ValueFormat } from "../format.js";
import { font, seriesColor, t } from "../tokens.js";
import { humanizeEnum } from "../values.js";
import { ChartEmpty, ChartFrame } from "./sanitize.js";

/** humanizeEnum lowercases, so only raw enum-shaped names are prettified. */
const sliceLabel = (name: string) => (/^[a-z0-9_-]+$/.test(name) ? humanizeEnum(name) : name);

export interface DonutChartProps {
  data: Array<Record<string, unknown>>;
  /** Slice-label field. */
  categoryKey: string;
  /** Slice-value field. */
  valueKey: string;
  /** Value-tier format for the legend + tooltips. */
  format?: ValueFormat;
  /** false renders a full pie. */
  donut?: boolean;
  height?: number;
  emptyState?: string;
}

export function DonutChart({
  data,
  categoryKey,
  valueKey,
  format = "number",
  donut = true,
  height = 220,
  emptyState = "No data to chart",
}: DonutChartProps) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined),
  // the same guard the other Kit charts get via sanitizeSeries.
  const slices = (Array.isArray(data) ? data : [])
    .map((row) => ({ name: sliceLabel(String(row[categoryKey] ?? "")), value: row[valueKey] }))
    .filter((s) => isRenderableNumber(s.value) && (s.value as number) > 0) as Array<{ name: string; value: number }>;
  if (slices.length === 0) {
    return <ChartEmpty height={height}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  const ring = Math.min(height, 140);
  return (
    <div data-kit="DonutChart" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ width: ring, flex: "0 0 auto" }}>
        <ChartFrame height={ring}>
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
              <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 12 }} />
            </RPieChart>
          </ResponsiveContainer>
        </ChartFrame>
      </div>
      {/* The ring alone says nothing in a screenshot — every slice states its own value. */}
      <div style={{ ...font, flex: "1 1 140px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                color: t.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ width: 8, height: 8, flex: "0 0 auto", borderRadius: 999, background: seriesColor(i) }} />
              {s.name}
            </span>
            <span style={{ color: t.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmt(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
