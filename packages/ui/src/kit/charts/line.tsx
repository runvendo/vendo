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

/** A series key, or a descriptor: `label` (or `name`, the same thing) renames it,
 *  `color` paints it, and any other engine prop paints THAT series alone — over
 *  the chart-level one it collides with.
 *
 *  `color` is the KIT's word for a series' paint, because the engine's own name
 *  for it is a different one per chart (`stroke` on a line, `fill` on a bar) and
 *  a passthrough that only spoke the engine's name left the obvious word landing
 *  on the SVG as an inert attribute: a chart that took seven hex colors and drew
 *  all seven from the theme. The engine's own name still wins where both are
 *  written.
 *
 *  `name` is that same lesson from the other side. It is the ENGINE's word for a
 *  series' label, so it is Omit-ed here and the component sets it from `label` —
 *  which left the most obvious word for the thing landing nowhere at all: a
 *  series written `{ key: "spend", name: "Spend" }` charted as "spend" and said
 *  nothing about why. So the KIT reads the word as an alias for `label`, and
 *  still owns what reaches the engine under it. */
export type SeriesInput<Engine = ComponentProps<typeof Line>> =
  | string
  | ({ key: string; label?: string; name?: string; color?: string } & Omit<Engine, "dataKey" | "name">);

/** Plus `format`: a line's value is PRINTED in the tooltip, and a chart of two
 *  series in different units (money and a count) has no one chart-level token
 *  that reads both. The chart's own `format` is the default, and the y-axis stays
 *  chart-level — one axis, one unit. */
type LineSeriesInput = SeriesInput<ComponentProps<typeof Line> & { format?: ValueFormat }>;

interface LineChartOwnProps extends KitStyled {
  /** Rows from a tool call. */
  data: Array<Record<string, unknown>>;
  /** Category (x) axis field. */
  xKey: string;
  /** One or more value series. */
  series: LineSeriesInput[];
  /** Value-tier format for y-axis ticks and tooltips. */
  format?: ValueFormat;
  /** Value-tier format for the x-axis ticks and the tooltip's own heading. The
   *  category axis had no format token at all, so a trend over days printed the
   *  raw "2026-07-30" the host stored under every tick while the figures beside
   *  it read in the host's own words. */
  xFormat?: ValueFormat;
  height?: number;
  emptyState?: string;
  /** Kit elements shown in place of `emptyState` when there is nothing to plot. */
  empty?: ReactNode;
  /** Kit value components composed for the hovered point, in place of the
   *  default tooltip. Written as a function of the point, it arrives as ONE
   *  element per point in `data` order. */
  tooltip?: ReactNode | readonly ReactNode[];
  /** A series key drawn under the chart. */
  legend?: ReactNode;
}

/** Plus any recharts `<Line>` prop, handed to EVERY line. It arrives AFTER the
 *  Kit's own defaults, so `stroke` wins, and BEFORE `dataKey`/`name`, which the
 *  component owns — an overridden one would plot a field that is not there. */
export type LineChartProps = LineChartOwnProps & KitEngine<ComponentProps<typeof Line>, LineChartOwnProps, "dataKey" | "name">;

function normalize(series: LineSeriesInput[]) {
  // `name` is SPENT here — it is the alias, and the `undefined` it leaves behind
  // is what `given()` drops, so the word never reaches the engine as the series
  // name the component owns.
  return series.map((s) => (typeof s === "string"
    ? { key: s, label: s, color: undefined, format: undefined }
    : { ...s, label: s.label ?? s.name ?? s.key, name: undefined }));
}

const axisTick = { fill: t.muted, fontSize: 11 };

export function LineChart({ data, xKey, series, format = "number", xFormat = "text", height = 220, emptyState = "No data to chart", empty, tooltip, legend, style, children, pending, ...engine }: LineChartProps & KitRendered) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    return <ChartEmpty height={height} slot={empty} style={style}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  const xfmt = (v: unknown) => applyFormat(v, xFormat) ?? "";
  return (
    <div
      data-kit="LineChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)", ...style }}
    >
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <RLineChart data={clean} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={t.border} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} tickFormatter={xfmt} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} width={56} />
            <Tooltip
              // The ONE place a line's value is printed, so it is the only place a
              // series' own `format` can land — and it used to land nowhere: the
              // word was dropped straight through to the engine, where it meant
              // nothing, so a duration series read "412" while the bar chart's
              // read "6m 52s" off the same prop. Recharts hands the formatter the
              // series' `name`, which is the label the Kit gave it, so the figure
              // reads in THAT series' units and the chart's own `format` is the
              // default for the rest.
              formatter={(v, name) => applyFormat(v, cols.find((c) => c.label === name)?.format ?? format) ?? ""}
              // The hovered point's HEADING is that same x value, so it reads in
              // the words its own tick does.
              labelFormatter={xfmt}
              // `clean` maps 1:1 over `data`, so it is the per-point slot's own
              // order — and it holds the objects recharts hands back on hover.
              content={tooltip === undefined ? undefined : slotTooltip(tooltip, clean)}
              contentStyle={tooltipSurface}
            />
            {/* `format` is read at the Tooltip and destructured out HERE, so it
                never reaches the engine as an inert SVG attribute. */}
            {cols.map(({ key, label, color, format: _seriesFormat, ...seriesEngine }, i) => (
              <Line
                type="monotone"
                stroke={color ?? seriesColor(i)}
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
