/** DonutChart — recharts Pie internals, data props only (W2 §The Kit). */
import type { ComponentProps, ReactNode } from "react";
import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import { isRenderableNumber, applyFormat, type ValueFormat } from "../format.js";
import { font, numeric, seriesColor, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { EnumBadge, humanizeEnum, type EnumTone } from "../values.js";
import { ChartEmpty, ChartFrame, slotTooltip, tooltipSurface } from "./sanitize.js";

interface DonutChartOwnProps extends KitStyled {
  data: Array<Record<string, unknown>>;
  /** Slice-label field. */
  categoryKey: string;
  /** Slice-value field. */
  valueKey: string;
  /** Value-tier format for tooltips. */
  format?: ValueFormat;
  /** Slice value → tone, exactly as EnumBadge takes it — the pills the legend
   *  gives a status ring. */
  tones?: Record<string, EnumTone>;
  /** false renders a full pie. */
  donut?: boolean;
  /** Name + value under the ring, on by default; `false` takes it away, and Kit
   *  elements replace it. */
  legend?: boolean | ReactNode;
  height?: number;
  emptyState?: string;
  /** Kit elements shown in place of `emptyState` when there is nothing to plot. */
  empty?: ReactNode;
  /** Kit value components composed for the hovered slice, in place of the
   *  default tooltip. Written as a function of the slice's row, it arrives as ONE
   *  element per row in `data` order. */
  tooltip?: ReactNode | readonly ReactNode[];
}

/** Plus any recharts `<Pie>` prop, handed straight to the ring. It arrives AFTER
 *  the Kit's own defaults, so `strokeWidth` wins, and BEFORE `dataKey`/`nameKey`,
 *  which the component owns — an overridden one would plot a field that is not
 *  there. A slice's own colour stays the `<Cell fill>` under it. */
export type DonutChartProps = DonutChartOwnProps & KitEngine<ComponentProps<typeof Pie>, DonutChartOwnProps, "dataKey" | "nameKey" | "data">;

/** Does the category field hold machine TOKENS rather than words a person wrote?
 *  One word each, at least one carrying a separator or a camel hump — "past_due"
 *  beside "active". It is the FIELD that is an enum or is not, so every slice
 *  answers together: judged one at a time, a status ring showed a pill for
 *  "past_due" and a bare word for "active". And it cannot be judged by casing
 *  alone — humanizing "ACME Corp" lowercases a proper noun, which is why the
 *  legend prints the data's own words for everything else. */
const isEnumField = (names: readonly string[]): boolean =>
  names.every((name) => /^\S+$/.test(name)) && names.some((name) => /[_-]|[a-z0-9][A-Z]/.test(name));

export function DonutChart({
  data,
  categoryKey,
  valueKey,
  format = "number",
  tones,
  donut = true,
  legend = true,
  height = 220,
  emptyState = "No data to chart",
  empty,
  tooltip,
  style,
  children, pending, ...engine
}: DonutChartProps & KitRendered) {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined),
  // the same guard the other Kit charts get via sanitizeSeries.
  // The whole row rides along under the slice's own two keys, so a `tooltip`
  // slot reads the same fields here as it does on a line or a bar. `at` is the
  // row's place in `data`, kept because UNRENDERABLE slices are still DROPPED: a
  // slice's place on the ring is not its row's, so a per-row tooltip list has to
  // be re-laid against the slices that survived or every hover past a dropped
  // one reads a row off.
  // A ZERO is not one of the dropped. It is real data — "this category spent
  // nothing" is an answer — and dropping it took the row out of the LEGEND too,
  // so a screenshot of five categories showed four and never said which one was
  // missing. It draws no arc, which is correct, and reads 0 under the ring.
  const slices = (Array.isArray(data) ? data : [])
    .map((row, at) => ({ ...row, at, name: String(row[categoryKey] ?? ""), value: row[valueKey] }))
    .filter((s) => isRenderableNumber(s.value)) as Array<{ at: number; name: string; value: number }>;
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
  // A negative value is REFUSED, out loud, rather than filtered: a donut states
  // shares of one whole, so a negative cannot be one of them. Dropped quietly it
  // takes its category out of the ring AND out of the legend while every
  // remaining share reads against the wrong total — a chart that is confidently
  // wrong. The box names the slice and what to draw instead; it does not throw (a
  // screen must not die on its data) and it does not take the absolute value,
  // which would invent a figure the host never said.
  const negative = slices.find((slice) => slice.value < 0);
  if (negative) {
    return (
      <ChartEmpty height={height} style={style}>
        {`Negative values aren't shares of a whole: “${negative.name}” is ${fmt(negative.value)}. Chart these as a BarChart instead.`}
      </ChartEmpty>
    );
  }
  if (slices.length === 0) {
    return <ChartEmpty height={height} slot={empty} style={style}>{emptyState}</ChartEmpty>;
  }
  const hovered = Array.isArray(tooltip) ? slices.map((slice) => tooltip[slice.at]) : tooltip;
  const enums = isEnumField(slices.map((slice) => slice.name));
  return (
    <div
      data-kit="DonutChart"
      style={{ display: "flex", flexDirection: "column", gap: "var(--vendo-density-inline-gap, 7px)", ...style }}
    >
      <ChartFrame height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <RPieChart>
            <Pie
              innerRadius={donut ? "58%" : 0}
              outerRadius="82%"
              paddingAngle={donut ? 2 : 0}
              stroke={t.surface}
              strokeWidth={2}
              isAnimationActive={false}
              {...given(engine)}
              data={slices}
              dataKey="value"
              nameKey="name"
            >
              {slices.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v, name) => [fmt(v), enums ? humanizeEnum(String(name)) : String(name)]}
              content={tooltip === undefined ? undefined : slotTooltip(hovered, slices)}
              contentStyle={tooltipSurface}
            />
          </RPieChart>
        </ResponsiveContainer>
      </ChartFrame>
      {/* An unlabelled ring says NOTHING in a screenshot — a hover tooltip is
          not a label (genbench spend-overview, 2026-08-11). Every slice is
          named and valued on the page itself. */}
      {legend === false ? null : legend !== true ? legend : (
        <ul
          data-kit="DonutLegend"
          style={{
            ...font,
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--vendo-density-inline-gap, 7px) var(--vendo-density-content-gap, 10px)",
            listStyle: "none",
            margin: 0,
            padding: 0,
            fontSize: "0.85em",
          }}
        >
          {slices.map((slice, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, flexShrink: 0, borderRadius: 999, background: seriesColor(i) }}
              />
              {/* An enum slice reads through EnumBadge — the same pill, label and
                  tone the DataTable beside it gives the identical field, where
                  the ring's own legend used to print the raw "past_due". A name
                  the data spells in words stays exactly as written. */}
              {enums ? <EnumBadge value={slice.name} tones={tones} /> : <span>{slice.name}</span>}
              <span style={{ ...numeric, color: t.muted }}>{fmt(slice.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
