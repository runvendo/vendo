/** BarChart — recharts internals, data props only, formatted ticks (W2 §The Kit). */
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { applyFormat, type ValueFormat } from "../format.js";
import { seriesColor, t } from "../tokens.js";
import { ChartEmpty, ChartFrame, sanitizeSeries, seriesIsEmpty } from "./sanitize.js";
import type { SeriesInput } from "./line.js";

export interface BarChartProps {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: SeriesInput[];
  format?: ValueFormat;
  /** Stack the series into one bar per category. */
  stacked?: boolean;
  /** Horizontal bars (good for ranked lists). */
  horizontal?: boolean;
  height?: number;
  emptyState?: string;
}

function normalize(series: SeriesInput[]): Array<{ key: string; label: string }> {
  return series.map((s) => (typeof s === "string" ? { key: s, label: s } : { key: s.key, label: s.label ?? s.key }));
}

const axisTick = { fill: "var(--vendo-color-muted, #6b6b76)", fontSize: 11 };

export function BarChart({
  data,
  xKey,
  series,
  format = "number",
  stacked = false,
  horizontal = false,
  height = 220,
  emptyState = "No data to chart",
}: BarChartProps) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    return <ChartEmpty height={height}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div data-kit="BarChart">
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <RBarChart data={clean} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={t.border} strokeDasharray="3 3" vertical={horizontal} horizontal={!horizontal} />
            {horizontal ? (
              <>
                <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} />
                <YAxis type="category" dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} width={96} />
              </>
            ) : (
              <>
                <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
              </>
            )}
            <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 12 }} cursor={{ fill: `color-mix(in srgb, ${t.muted} 10%, transparent)` }} />
            {cols.map((c, i) => (
              <Bar
                key={c.key}
                dataKey={c.key}
                name={c.label}
                fill={seriesColor(i)}
                radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                stackId={stacked ? "stack" : undefined}
                isAnimationActive={false}
              />
            ))}
          </RBarChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
