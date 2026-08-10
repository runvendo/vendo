/** DonutChart — recharts Pie internals, data props only (W2 §The Kit). */
import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import { isRenderableNumber, applyFormat, type ValueFormat } from "../format.js";
import { font, seriesColor, t } from "../tokens.js";
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
  const rows = (Array.isArray(data) ? data : []).map((row) => ({ name: String(row[categoryKey] ?? ""), value: row[valueKey] }));
  const slices = rows.filter((s) => isRenderableNumber(s.value) && (s.value as number) > 0) as Array<{ name: string; value: number }>;
  if (slices.length === 0) {
    return <ChartEmpty height={height}>{emptyState}</ChartEmpty>;
  }
  // A zero slice draws nothing, so name it instead of deleting the category silently.
  const zeroNames = rows.filter((s) => s.name !== "" && s.value === 0).map((s) => s.name);
  const shown = zeroNames.length > 4 ? [...zeroNames.slice(0, 4), `+${zeroNames.length - 4} more`] : zeroNames;
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div data-kit="DonutChart">
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
            <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 12 }} />
          </RPieChart>
        </ResponsiveContainer>
      </ChartFrame>
      {shown.length > 0 && (
        <div style={{ ...font, color: t.muted, fontSize: "0.85em", padding: "var(--vendo-density-field-gap, 6px) 0 0" }}>{`None: ${shown.join(", ")}`}</div>
      )}
    </div>
  );
}
