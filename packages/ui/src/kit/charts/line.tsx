/** LineChart — recharts internals, data props only, formatted ticks (W2 §The Kit). */
import {
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { applyFormat, type ValueFormat } from "../format.js";
import { seriesColor, t } from "../tokens.js";
import { ChartEmpty, ChartFrame, sanitizeSeries, seriesIsEmpty } from "./sanitize.js";

export type SeriesInput = string | { key: string; label?: string };

export interface LineChartProps {
  /** Rows from a tool call. */
  data: Array<Record<string, unknown>>;
  /** Category (x) axis field. */
  xKey: string;
  /** One or more value series. */
  series: SeriesInput[];
  /** Value-tier format for y-axis ticks and tooltips. */
  format?: ValueFormat;
  height?: number;
  emptyState?: string;
}

function normalize(series: SeriesInput[]): Array<{ key: string; label: string }> {
  return series.map((s) => (typeof s === "string" ? { key: s, label: s } : { key: s.key, label: s.label ?? s.key }));
}

const axisTick = { fill: "var(--vendo-color-muted, #6b6b76)", fontSize: 11 };

export function LineChart({ data, xKey, series, format = "number", height = 220, emptyState = "No data to chart" }: LineChartProps) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    return <ChartEmpty height={height}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div data-kit="LineChart">
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <RLineChart data={clean} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={t.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
            <Tooltip formatter={(v) => fmt(v)} contentStyle={{ borderRadius: 8, border: `1px solid ${t.border}`, fontSize: 12 }} />
            {cols.map((c, i) => (
              <Line
                key={c.key}
                type="monotone"
                dataKey={c.key}
                name={c.label}
                stroke={seriesColor(i)}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </RLineChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
