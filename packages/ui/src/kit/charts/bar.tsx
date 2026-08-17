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
import type { ComponentProps, ReactNode } from "react";
import { applyFormat, type ValueFormat } from "../format.js";
import { seriesColor, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { ChartEmpty, ChartFrame, sanitizeSeries, seriesIsEmpty, slotTooltip, tooltipSurface } from "./sanitize.js";
import type { SeriesInput } from "./line.js";

type BarSeriesInput = SeriesInput<ComponentProps<typeof Bar>>;

interface BarChartOwnProps extends KitStyled {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: BarSeriesInput[];
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

/** Plus any recharts `<Bar>` prop, handed to EVERY bar. It arrives AFTER the
 *  Kit's own defaults, so `fill` wins, and BEFORE `dataKey`/`name`, which the
 *  component owns — an overridden one would plot a field that is not there. */
export type BarChartProps = BarChartOwnProps & KitEngine<ComponentProps<typeof Bar>, BarChartOwnProps, "dataKey" | "name">;

function normalize(series: BarSeriesInput[]) {
  return series.map((s) => (typeof s === "string" ? { key: s, label: s, color: undefined } : { ...s, label: s.label ?? s.key }));
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
  style,
  children, pending, ...engine
}: BarChartProps & KitRendered) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    return <ChartEmpty height={height} slot={empty} style={style}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div
      data-kit="BarChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)", ...style }}
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
            {cols.map(({ key, label, color, ...seriesEngine }, i) => (
              <Bar
                fill={color ?? seriesColor(i)}
                radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                stackId={stacked ? "stack" : undefined}
                isAnimationActive={false}
                {...given(engine)}
                {...given(seriesEngine)}
                key={key}
                dataKey={key}
                name={label}
              />
            ))}
          </RBarChart>
        </ResponsiveContainer>
      </ChartFrame>
      {legend}
    </div>
  );
}
