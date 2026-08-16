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
import type { ComponentProps, ReactNode } from "react";
import { applyFormat, type ValueFormat } from "../format.js";
import { seriesColor, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { ChartEmpty, ChartFrame, sanitizeSeries, seriesIsEmpty, slotTooltip, tooltipSurface } from "./sanitize.js";

/** A series key, or a descriptor: `label` renames it, and any other engine prop
 *  paints THAT series alone — over the chart-level one it collides with. */
export type SeriesInput<Engine = ComponentProps<typeof Line>> =
  | string
  | ({ key: string; label?: string } & Omit<Engine, "dataKey" | "name">);

interface LineChartOwnProps extends KitStyled {
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
  /** Kit elements shown in place of `emptyState` when there is nothing to plot. */
  empty?: ReactNode;
  /** Kit value components composed for the hovered point, in place of the
   *  default tooltip; the point rides on `RowContext`. */
  tooltip?: ReactNode;
  /** A series key drawn under the chart. */
  legend?: ReactNode;
}

/** Plus any recharts `<Line>` prop, handed to EVERY line. It arrives AFTER the
 *  Kit's own defaults, so `stroke` wins, and BEFORE `dataKey`/`name`, which the
 *  component owns — an overridden one would plot a field that is not there. */
export type LineChartProps = LineChartOwnProps & KitEngine<ComponentProps<typeof Line>, LineChartOwnProps, "dataKey" | "name">;

function normalize(series: SeriesInput[]) {
  return series.map((s) => (typeof s === "string" ? { key: s, label: s } : { ...s, label: s.label ?? s.key }));
}

const axisTick = { fill: t.muted, fontSize: 11 };

export function LineChart({ data, xKey, series, format = "number", height = 220, emptyState = "No data to chart", empty, tooltip, legend, style, children, pending, ...engine }: LineChartProps & KitRendered) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    // The slot replaces the dashed box, not its TEXT: what goes in one is an
    // EmptyState, which draws that same frame itself — nested, it read as a
    // box inside a box.
    return empty ?? <ChartEmpty height={height} style={style}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  return (
    <div
      data-kit="LineChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)", ...style }}
    >
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <RLineChart data={clean} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={t.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
            <Tooltip
              formatter={(v) => fmt(v)}
              content={tooltip === undefined ? undefined : slotTooltip(tooltip)}
              contentStyle={tooltipSurface}
            />
            {cols.map(({ key, label, ...seriesEngine }, i) => (
              <Line
                type="monotone"
                stroke={seriesColor(i)}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
                {...given(engine)}
                {...given(seriesEngine)}
                key={key}
                dataKey={key}
                name={label}
              />
            ))}
          </RLineChart>
        </ResponsiveContainer>
      </ChartFrame>
      {legend}
    </div>
  );
}
