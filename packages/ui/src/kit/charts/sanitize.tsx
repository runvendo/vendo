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

/** The label/value pairs a chart was HANDED, read as text. Non-empty only when
 *  the rows exist and carry a string under the plotted key — a `format(...)`
 *  reshape hands a chart pre-formatted strings, and text is still an answer.
 *  Numbers are ignored on purpose: a finite one would have been plotted, and a
 *  non-finite one must never surface as "NaN". */
export function textValueRows(
  rows: unknown,
  labelKey: string,
  valueKey: string,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const value = (row as Record<string, unknown>)?.[valueKey];
      return {
        label: String((row as Record<string, unknown>)?.[labelKey] ?? "").trim(),
        value: typeof value === "string" ? value.trim() : "",
      };
    })
    .filter((item) => item.label !== "" && item.value !== "");
}

/** One line per row: muted label left, value right, tabular digits. */
export function ChartValueList({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <ul
      data-kit="ChartValueList"
      style={{
        ...font,
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-field-gap, 6px)",
      }}
    >
      {items.map((item) => (
        <li key={item.label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ color: t.muted }}>{item.label}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{item.value}</span>
        </li>
      ))}
    </ul>
  );
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
