/**
 * Chart data hygiene (W2 §The Kit). `$NaN` is unrenderable: non-finite series
 * values become `null` (recharts draws a gap, never "NaN"); number lists drop
 * them. A designed empty/invalid state is shown when nothing is left to plot.
 */
import type { CSSProperties, ReactNode } from "react";
import { isRenderableNumber } from "../format.js";
import { font, t } from "../tokens.js";

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

/** A designed empty/invalid state that reads as intentional, not broken. */
export function ChartEmpty({ height = 220, children }: { height?: number; children: ReactNode }) {
  const style: CSSProperties = {
    ...font,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height,
    minHeight: height,
    color: t.muted,
    border: `1px dashed ${t.border}`,
    borderRadius: t.radiusMedium,
    background: `color-mix(in srgb, ${t.background} 40%, transparent)`,
    fontSize: "0.9em",
    textAlign: "center",
    padding: 12,
  };
  return <div data-kit="ChartEmpty">{<div style={style}>{children}</div>}</div>;
}
