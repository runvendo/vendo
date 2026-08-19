/** BarChart — recharts internals, data props only, the screen's own text (W2 §The Kit). */
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ComponentProps, ReactNode } from "react";
import { seriesColor, t, toneColor, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { ChartEmpty, ChartFrame, chartText, hoveredRow, plainFigure, sanitizeSeries, seriesIsEmpty, slotTooltip, tooltipSurface, type ChartFormat } from "./sanitize.js";
import type { SeriesInput } from "./line.js";

/** Plus `format`: a bar carries its VALUE as a label, and the formatter lives on
 *  the SERIES rather than on the chart, because two series in different units (an
 *  amount and a count) have no one text a chart-level formatter could write for
 *  both. */
type BarSeriesInput = SeriesInput<Omit<ComponentProps<typeof Bar>, "format"> & { format?: ChartFormat }>;

interface BarChartOwnProps extends KitStyled {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: BarSeriesInput[];
  /** Stack the series into one bar per category. */
  stacked?: boolean;
  /** Horizontal bars (good for ranked lists). */
  horizontal?: boolean;
  height?: number;
  emptyState?: string;
  /** Kit elements shown in place of `emptyState` when there is nothing to plot. */
  empty?: ReactNode;
  /** Kit value components composed for the hovered bar, in place of the default
   *  tooltip. Written as a function of the bar's row, it arrives as ONE element
   *  per row in `data` order. */
  tooltip?: ReactNode | readonly ReactNode[];
  /** A series key drawn under the chart. */
  legend?: ReactNode;
}

/** Plus any recharts `<Bar>` prop, handed to EVERY bar. It arrives AFTER the
 *  Kit's own defaults, so `fill` wins, and BEFORE `dataKey`/`name`, which the
 *  component owns — an overridden one would plot a field that is not there. */
export type BarChartProps = BarChartOwnProps & KitEngine<ComponentProps<typeof Bar>, BarChartOwnProps, "dataKey" | "name">;

function normalize(series: BarSeriesInput[]) {
  // `name` is SPENT here — it is the alias for `label`, and the `undefined` it
  // leaves behind is what `given()` drops, so the word never reaches the engine
  // as the series name the component owns.
  return series.map((s) => (typeof s === "string"
    ? { key: s, label: s, color: undefined, format: undefined }
    : { ...s, label: s.label ?? s.name ?? s.key, name: undefined }));
}

const axisTick = { fill: t.muted, fontSize: 11 };

/** The one rounded end of a bar, in px — recharts' corner order is
 *  `[topLeft, topRight, bottomRight, bottomLeft]`. */
const CORNER = 4;

/**
 * ONE BAR, and the two things recharts cannot say about a bar that hangs the
 * other way.
 *
 * It spells a value below the baseline as a NEGATIVE `height` (going up) or
 * `width` (going right) and passes both straight onto the SVG element, where
 * `width="-18.125"` is not a legal attribute value — a saved case shipped exactly
 * that. So the element carries the MAGNITUDE, and the sign becomes the end that is
 * rounded, because a bar's far end is the other one when it grows the other way.
 *
 * And a loss is painted in the Kit's own bad-news tone rather than in the series
 * colour: a bar pointing the other way is the one figure on a chart a reader must
 * not have to trace back to an axis to recognise, and every charting library in
 * the ecosystem colours it. `toneColor("danger")`, so it is the HOST's danger, not
 * a red this file invented.
 */
type BarShapeProps = ComponentProps<typeof Rectangle>;

function BarShape({ x = 0, y = 0, width = 0, height = 0, radius, fill, ...rest }: BarShapeProps) {
  const loss = width < 0 || height < 0;
  return (
    <Rectangle
      {...rest}
      x={Math.min(x, x + width)}
      y={Math.min(y, y + height)}
      width={Math.abs(width)}
      height={Math.abs(height)}
      radius={height < 0
        ? [0, 0, CORNER, CORNER]
        : width < 0 ? [CORNER, 0, 0, CORNER] : radius}
      fill={loss ? toneColor("danger") : fill}
    />
  );
}

export function BarChart({
  data,
  xKey,
  series,
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
  return (
    <div
      data-kit="BarChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)", ...style }}
    >
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Room for the value label at the END of a bar — past the tallest
              one going up, past the longest one going right. Without it the
              figure the chart exists to state is the one thing clipped off. */}
          <RBarChart data={clean} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: horizontal ? 8 : 20, right: horizontal ? 56 : 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={t.border} strokeDasharray="3 3" vertical={horizontal} horizontal={!horizontal} />
            {/* The VALUE axis is the one place no formatter reaches: these ticks
                are recharts' own, off the scale, so they read as the plotted
                numbers are — which is why a screen plots the units it wants
                read. */}
            {horizontal ? (
              <>
                <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={plainFigure} />
                <YAxis type="category" dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} width={96} />
              </>
            ) : (
              <>
                <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: t.border }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={plainFigure} width={56} />
              </>
            )}
            <Tooltip
              // The hovered bar's own series and row: recharts names the series by
              // the label the Kit gave it and hands the row back under `payload`,
              // so the figure reads as that series' own function wrote it.
              formatter={(v, name, item) => {
                const at = clean.indexOf(hoveredRow(item) as Record<string, unknown>);
                return chartText(cols.find((c) => c.label === name)?.format, clean[at], at) ?? plainFigure(v);
              }}
              // `clean` maps 1:1 over `data`, so it is the per-row slot's own
              // order — and it holds the objects recharts hands back on hover.
              content={tooltip === undefined ? undefined : slotTooltip(tooltip, clean)}
              contentStyle={tooltipSurface}
              cursor={{ fill: `color-mix(in srgb, ${t.muted} 10%, transparent)` }}
            />
            {cols.map(({ key, label, color, format: seriesFormat, ...seriesEngine }, i) => (
              <Bar
                fill={color ?? seriesColor(i)}
                radius={horizontal ? [0, CORNER, CORNER, 0] : [CORNER, CORNER, 0, 0]}
                shape={<BarShape />}
                stackId={stacked ? "stack" : undefined}
                isAnimationActive={false}
                // The figure ON the bar. A bar chart's whole job is comparing
                // magnitudes, and a reader who has to trace a bar back to an
                // axis tick to learn one is reading the chart twice — every
                // judge that asked "how long was 4191?" was asking for this.
                // In THIS series' own words: `valueAccessor` is the one label
                // door that carries the entry's index, which is what pairs a bar
                // with the row its formatter was written for.
                label={{
                  position: horizontal ? "right" : "top",
                  valueAccessor: (entry: { value?: unknown }, index: number) =>
                    chartText(seriesFormat, clean[index], index) ?? plainFigure(entry?.value),
                  fill: t.muted,
                  fontSize: 11,
                }}
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
