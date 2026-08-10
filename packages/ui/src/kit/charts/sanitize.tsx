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

/** Common chart wrapper providing a min-height box. */
export function ChartFrame({ height = 220, children }: ChartFrameProps) {
  return <div style={{ width: "100%", height, minHeight: height }}>{children}</div>;
}

/** A designed empty/invalid state that reads as intentional, not broken. It is
 * sized by its sentence — reserving the chart's height left a card that was
 * mostly blank dashed void. */
export function ChartEmpty({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    ...font,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    color: t.muted,
    border: `1px dashed ${t.border}`,
    borderRadius: t.radiusMedium,
    background: `color-mix(in srgb, ${t.background} 40%, transparent)`,
    fontSize: "0.9em",
    textAlign: "center",
    padding: "var(--vendo-density-card-padding, 16px)",
  };
  return <div data-kit="ChartEmpty">{<div style={style}>{children}</div>}</div>;
}

export interface ChartLegendItem {
  label: string;
  /** Formatted figure; omitted for series a legend only names. */
  value?: string;
  color: string;
}

/** Series labels a screenshot can actually read — recharts keeps them inside a
 * `Tooltip`, which only exists on hover. */
export function ChartLegend({ items }: { items: ChartLegendItem[] }) {
  return (
    <div
      data-kit="ChartLegend"
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-field-gap, 6px)",
        marginTop: "var(--vendo-density-content-gap, 10px)",
        fontSize: "0.85em",
      }}
    >
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "var(--vendo-density-inline-gap, 7px)" }}>
          <span
            aria-hidden="true"
            style={{ flex: "none", width: 10, height: 10, borderRadius: 2, background: item.color }}
          />
          <span style={{ color: t.muted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.label}
          </span>
          {item.value === undefined ? null : (
            <span style={{ color: t.text, fontVariantNumeric: "tabular-nums", marginLeft: "auto", textAlign: "right" }}>
              {item.value}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
