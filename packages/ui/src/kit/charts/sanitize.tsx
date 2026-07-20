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

/** Common chart wrapper providing a min-height box. */
export function ChartFrame({ height = 220, children }: ChartFrameProps) {
  return <div style={{ width: "100%", height, minHeight: height }}>{children}</div>;
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
