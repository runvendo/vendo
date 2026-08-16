/** DonutChart — recharts Pie internals, data props only (W2 §The Kit). */
import type { ComponentProps, ReactNode } from "react";
import { Cell, Pie, PieChart as RPieChart, ResponsiveContainer, Tooltip } from "recharts";
import { isRenderableNumber, applyFormat, type ValueFormat } from "../format.js";
import { font, numeric, seriesColor, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { ChartEmpty, ChartFrame, slotTooltip, tooltipSurface } from "./sanitize.js";

interface DonutChartOwnProps extends KitStyled {
  data: Array<Record<string, unknown>>;
  /** Slice-label field. */
  categoryKey: string;
  /** Slice-value field. */
  valueKey: string;
  /** Value-tier format for tooltips. */
  format?: ValueFormat;
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
   *  default tooltip; the slice's row rides on `RowContext`. */
  tooltip?: ReactNode;
}

/** Plus any recharts `<Pie>` prop, handed straight to the ring. It arrives AFTER
 *  the Kit's own defaults, so `strokeWidth` wins, and BEFORE `dataKey`/`nameKey`,
 *  which the component owns — an overridden one would plot a field that is not
 *  there. A slice's own colour stays the `<Cell fill>` under it. */
export type DonutChartProps = DonutChartOwnProps & KitEngine<ComponentProps<typeof Pie>, DonutChartOwnProps, "dataKey" | "nameKey" | "data">;

export function DonutChart({
  data,
  categoryKey,
  valueKey,
  format = "number",
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
  // slot reads the same fields here as it does on a line or a bar.
  const slices = (Array.isArray(data) ? data : [])
    .map((row) => ({ ...row, name: String(row[categoryKey] ?? ""), value: row[valueKey] }))
    .filter((s) => isRenderableNumber(s.value) && (s.value as number) > 0) as Array<{ name: string; value: number }>;
  if (slices.length === 0) {
    // The slot replaces the dashed box, not its TEXT: what goes in one is an
    // EmptyState, which draws that same frame itself — nested, it read as a
    // box inside a box.
    return empty ?? <ChartEmpty height={height} style={style}>{emptyState}</ChartEmpty>;
  }
  const fmt = (v: unknown) => applyFormat(v, format) ?? "";
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
              formatter={(v) => fmt(v)}
              content={tooltip === undefined ? undefined : slotTooltip(tooltip)}
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
              {/* The name as the DATA spells it, which is what the slice's own
                  tooltip shows: humanizing lowercased proper nouns ("ACME Corp"
                  → "Acme corp") and made the two disagree. */}
              <span>{slice.name}</span>
              <span style={{ ...numeric, color: t.muted }}>{fmt(slice.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
