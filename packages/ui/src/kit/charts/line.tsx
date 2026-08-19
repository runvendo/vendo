/** LineChart — recharts internals, data props only, the screen's own text (W2 §The Kit). */
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
import { seriesColor, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { ChartEmpty, ChartFrame, chartText, hoveredRow, plainFigure, sanitizeSeries, seriesIsEmpty, slotTooltip, tooltipSurface, type ChartFormat } from "./sanitize.js";

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

/** Plus `format`: a line's value is PRINTED in the tooltip, so it is the one place
 *  a series' figure is written out — and the formatter lives on the SERIES rather
 *  than on the chart, because two lines in different units (an amount and a count)
 *  have no one text a chart-level formatter could write for both.
 *
 *  It is Omit-ed from the engine before ours is added, the same move `dataKey` and
 *  `name` take: React's SVG attribute list carries a legacy `format?: string`, and
 *  an un-omitted one INTERSECTS with the Kit's into a type no function satisfies. */
type LineSeriesInput = SeriesInput<Omit<ComponentProps<typeof Line>, "format"> & { format?: ChartFormat }>;

interface LineChartOwnProps extends KitStyled {
  /** Rows from a tool call. */
  data: Array<Record<string, unknown>>;
  /** Category (x) axis field. */
  xKey: string;
  /** One or more value series. */
  series: LineSeriesInput[];
  /** The x tick and the hovered point's heading, as a function of the row —
   *  `(row) => day(row.month)`. Without it the axis prints the raw "2026-07-30"
   *  the host stored under every tick. */
  xFormat?: ChartFormat;
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

export function LineChart({ data, xKey, series, xFormat, height = 220, emptyState = "No data to chart", empty, tooltip, legend, style, children, pending, ...engine }: LineChartProps & KitRendered) {
  const cols = normalize(series);
  const keys = cols.map((c) => c.key);
  const clean = sanitizeSeries(data, keys);
  if (clean.length === 0 || seriesIsEmpty(clean, keys)) {
    return <ChartEmpty height={height} slot={empty} style={style}>{emptyState}</ChartEmpty>;
  }
  // An x tick is matched back to its row BY VALUE rather than by the index
  // recharts passes: a crowded axis draws only some of its ticks, and that index
  // is the tick's place among the ones drawn. A category the data repeats picks
  // the first row that carries it, which is the same text either row would give.
  const xAt = (value: unknown) => clean.findIndex((row) => row[xKey] === value);
  const xfmt = (v: unknown) => {
    const at = xAt(v);
    return chartText(xFormat, clean[at], at) ?? plainFigure(v);
  };
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
            {/* The y axis is the one place no formatter reaches: these ticks are
                recharts' own, off the scale, so they read as the plotted numbers
                are — which is why a screen plots the units it wants read. */}
            <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={plainFigure} width={56} />
            <Tooltip
              // The ONE place a line's value is printed, so it is the only place a
              // series' own formatter lands. Recharts hands the formatter the
              // series' `name` — the label the Kit gave it — and the hovered row
              // under `payload`, so the figure reads as THAT series' own function
              // wrote it for THAT row.
              formatter={(v, name, item) => {
                const at = clean.indexOf(hoveredRow(item) as Record<string, unknown>);
                return chartText(cols.find((c) => c.label === name)?.format, clean[at], at) ?? plainFigure(v);
              }}
              // The hovered point's HEADING is that same x value, so it reads in
              // the words its own tick does.
              labelFormatter={xfmt}
              // `clean` maps 1:1 over `data`, so it is the per-point slot's own
              // order — and it holds the objects recharts hands back on hover.
              content={tooltip === undefined ? undefined : slotTooltip(tooltip, clean)}
              contentStyle={tooltipSurface}
            />
            {/* `format` is read at the Tooltip and destructured out HERE, so the
                screen's own function never reaches the engine as an inert SVG
                attribute. */}
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
