/**
 * Chart data hygiene (W2 §The Kit). `$NaN` is unrenderable: non-finite series
 * values become `null` (recharts draws a gap, never "NaN"); number lists drop
 * them. A designed empty/invalid state is shown when nothing is left to plot.
 */
import type { CSSProperties, ReactNode } from "react";
import type { TooltipContentProps } from "recharts";
import { EmptyOrForming } from "../../tree/forming-skeleton.js";
import { applyFormat, formatNum, isRenderableNumber } from "../format.js";
import { rowSlot, type KitRow } from "../row.js";
import { font, hairline, t, type KitStyled } from "../tokens.js";

/**
 * A chart's FORMATTER — the screen's own `Intl` helper, written as a function of
 * the row.
 *
 * The Kit formats nothing. A figure a chart prints — a slice's legend line, a
 * bar's label, a hovered point, an x tick — is the screen's own text, because the
 * screen is the only place that knows what the host's numbers ARE: the `format`
 * tokens that used to say it were the last thing in the Kit that could turn 285000
 * cents into "$285,000.00" without anyone writing the division down.
 *
 * It is the per-row slot law at a text arity (`row.ts` `rowSlot`): the screen VM
 * calls the function once per row and hands the component a LIST of strings in
 * `data` order (apps `contract/kit/specs.ts` KIT_SLOT_PROPS), while a chart
 * written by hand in React passes the function itself. Both arrive here, and both
 * read the same in a screen's source.
 *
 * What no formatter can reach is a Y AXIS TICK: recharts invents those off the
 * scale, so they are numbers the screen never held a row of. They read through
 * {@link plainFigure} and nothing else — which is why the chart's own numbers must
 * already be in the units a reader wants.
 */
export type ChartFormat = ((row: KitRow, index: number) => string) | readonly string[];

/** This row's finished text, where the screen wrote a formatter for it. A row the
 *  lookup could not place (`index` of -1) has no text, not the wrong row's. */
export const chartText = (
  format: ChartFormat | undefined,
  row: KitRow | undefined,
  index: number,
): string | undefined =>
  typeof format === "function"
    ? (row === undefined ? undefined : format(row, index))
    : format?.[index];

/** The figure as it stands, with the host's own digit grouping — what every
 *  unformatted number on a chart reads as, so a bare chart is still legible
 *  (285000 → "285,000") without the Kit claiming to know what it means. */
export const plainFigure = (value: unknown): string =>
  formatNum(value as number) ?? applyFormat(value, "text") ?? "";

/** The ROW behind a hovered point — recharts hands the plotted object back under
 *  `payload`, and matching on it is what pairs a hover with the row whose
 *  formatter wrote the figure (the same identity match `slotTooltip` makes). */
export const hoveredRow = (item: unknown): unknown =>
  (item as { payload?: unknown } | undefined)?.payload;

/** Replace non-finite values in the given series keys with `null`. */
export function sanitizeSeries<T extends Record<string, unknown>>(
  rows: T[],
  keys: string[],
): Array<Record<string, unknown>> {
  // W3 — fail SOFT on missing data (a failed query resolves to undefined).
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of keys) {
      const v = row[key];
      out[key] = isRenderableNumber(v) ? v : null;
    }
    return out;
  });
}

/** Keep only finite numbers. */
export function sanitizeNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter(isRenderableNumber);
}

/** True when no series key holds any finite value across the rows. */
export function seriesIsEmpty(rows: Array<Record<string, unknown>>, keys: string[]): boolean {
  return !rows.some((row) => keys.some((key) => isRenderableNumber(row[key])));
}

export interface ChartFrameProps {
  height?: number;
  children: ReactNode;
}

/** Common chart wrapper providing a min-height box, and an intrinsic WIDTH.
 *
 *  `width: 100%` alone measures zero wherever the parent sizes itself to its
 *  content — the Kit's own `Row` is exactly that (flex, basis auto), so
 *  `<Row><DonutChart/></Row>` gave recharts a 0-wide container and it drew
 *  nothing: an empty 220px gap where the chart should be, and with it the only
 *  brand-accent pixels a screen usually has (genbench spend-overview,
 *  2026-08-11). The ratio transfers the definite height into a width for a
 *  parent that has to ASK, and is ignored by one that already has a width — so a
 *  narrow Grid track still squeezes the chart instead of overflowing it, which a
 *  `min-width` floor would not do. */
export function ChartFrame({ height = 220, children }: ChartFrameProps) {
  return <div style={{ width: "100%", aspectRatio: 1, height, minHeight: height }}>{children}</div>;
}

/** A designed empty/invalid state that reads as intentional, not broken.
 *
 *  ONE element, because a chart's `style` has to land on the same root whether it
 *  has points or not: nested, the caller's margin sat on an inner box while the
 *  populated chart put it on the outer one, so an empty chart moved.
 *
 *  `slot` is the author's own empty content, and it replaces this box rather than
 *  its TEXT: what goes in one is an EmptyState, which draws that same frame
 *  itself — nested, it read as a box inside a box. All three charts return this
 *  ONE branch, so the author's copy and the default copy are held back by the
 *  same rule while the build is still forming. */
export function ChartEmpty({ height = 220, children, slot, style }: { height?: number; children: ReactNode; slot?: ReactNode } & KitStyled) {
  if (slot !== undefined) return <EmptyOrForming>{slot}</EmptyOrForming>;
  const box: CSSProperties = {
    ...font,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height,
    minHeight: height,
    color: t.muted,
    border: `${t.borderWidth} dashed ${t.border}`,
    borderRadius: t.radiusMedium,
    background: `color-mix(in srgb, ${t.background} 40%, transparent)`,
    fontSize: "0.9em",
    textAlign: "center",
    padding: 12,
    ...style,
  };
  return <div data-kit="ChartEmpty" style={box}><EmptyOrForming>{children}</EmptyOrForming></div>;
}

/** The hover surface all three charts share — recharts paints its own content
 *  into it through `contentStyle`, and a `tooltip` slot gets the same one so a
 *  branded tooltip is not a bare row of text floating over the plot. */
export const tooltipSurface: CSSProperties = {
  borderRadius: t.radiusSmall,
  border: hairline,
  background: t.surface,
  color: t.text,
  fontSize: 12,
  boxShadow: t.shadowSmall,
};

/**
 * A `tooltip` slot, as recharts' `content`.
 *
 * A FUNCTION, never the element itself: recharts clones whatever element it is
 * handed with its own eighteen internal props, which React then writes onto the
 * slot's DOM node as attributes (`allowescapeviewbox="[object Object]"`) and
 * warns about, one line apiece. The function is called with the same props and
 * hands back the slot untouched.
 *
 * A per-point slot arrives as one element PER POINT, and the only thing recharts
 * hands over about WHICH point is the hovered payload itself — `activeIndex` is
 * typed `string | null` and means a different thing per chart family. So the
 * point is matched by IDENTITY, as a DataTable row is, against `plotted`: the
 * very array the engine was given, laid in the same order as `tooltip`.
 */
export const slotTooltip = (tooltip: ReactNode | readonly ReactNode[], plotted: readonly unknown[]) =>
  ({ payload }: Pick<TooltipContentProps<number, string>, "payload">) => (
    <div style={{ ...font, ...tooltipSurface, padding: "6px 9px" }}>
      {rowSlot(tooltip, plotted.indexOf(payload?.[0]?.payload))}
    </div>
  );
