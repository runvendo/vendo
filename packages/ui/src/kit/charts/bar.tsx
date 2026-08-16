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
import type { ReactNode } from "react";
import { applyFormat, type ValueFormat } from "../format.js";
import { seriesColor, t } from "../tokens.js";
import { ChartEmpty, ChartFrame, sanitizeSeries, seriesIsEmpty, slotTooltip, tooltipSurface } from "./sanitize.js";
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
  /** Kit elements shown in place of `emptyState` when there is nothing to plot. */
  empty?: ReactNode;
  /** Kit value components composed for the hovered bar, in place of the default
   *  tooltip; the bar's row rides on `RowContext`. */
  tooltip?: ReactNode;
  /** A series key drawn under the chart. */
  legend?: ReactNode;
}

function normalize(series: SeriesInput[]): Array<{ key: string; label: string }> {
  return series.map((s) => (typeof s === "string" ? { key: s, label: s } : { key: s.key, label: s.label ?? s.key }));
}

const axisTick = { fill: t.muted, fontSize: 11 };

export function BarChart({
  data,
  xKey,
  series,
  format = "number",
  stacked = false,
  horizontal = false,
  height = 220,
  emptyState = "No data to chart",
  empty,
  tooltip,
  legend,
}: BarChartProps) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    // The slot replaces the dashed box, not its TEXT: what goes in one is an
    // EmptyState, which draws that same frame itself — nested, it read as a
    // box inside a box.
    return empty ?? <ChartEmpty height={height}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div
      data-kit="BarChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)" }}
    >
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
            <Tooltip
              formatter={(v) => fmt(v)}
              content={tooltip === undefined ? undefined : slotTooltip(tooltip)}
              contentStyle={tooltipSurface}
              cursor={{ fill: `color-mix(in srgb, ${t.muted} 10%, transparent)` }}
            />
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
      {legend}
    </div>
  );
}
