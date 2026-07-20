/**
 * Shared style tokens for the Kit. Every value resolves to a host `--vendo-*`
 * theme variable with a porcelain default — so a Kit component is brand-native
 * on any host and never hardcodes Vendo's own brand (W2 §The Kit, axis 1).
 */
import type { CSSProperties } from "react";

export const t = {
  text: "var(--vendo-color-text, #1a1a1e)",
  muted: "var(--vendo-color-muted, #6b6b76)",
  surface: "var(--vendo-color-surface, #ffffff)",
  background: "var(--vendo-color-background, #f7f7f8)",
  accent: "var(--vendo-color-accent, #111111)",
  accentText: "var(--vendo-color-accent-text, #ffffff)",
  danger: "var(--vendo-color-danger, #c62f2f)",
  border: "var(--vendo-color-border, #e3e3e8)",
  radiusSmall: "var(--vendo-radius-small, 6px)",
  radiusMedium: "var(--vendo-radius-medium, 10px)",
  radiusLarge: "var(--vendo-radius-large, 16px)",
  fontFamily: "var(--vendo-font-family, system-ui, sans-serif)",
  headingFamily: "var(--vendo-heading-family, var(--vendo-font-family, system-ui, sans-serif))",
  fontSize: "var(--vendo-font-size, 15px)",
  motionDuration: "var(--vendo-motion-duration, 160ms)",
  motionEasing: "var(--vendo-motion-easing, cubic-bezier(0.2, 0.8, 0.2, 1))",
} as const;

/** Base text style shared by every Kit component. */
export const font: CSSProperties = {
  color: t.text,
  fontFamily: t.fontFamily,
  fontSize: t.fontSize,
};

/** A form control (input/select) surface. */
export const control: CSSProperties = {
  ...font,
  width: "100%",
  minWidth: 0,
  minHeight: "var(--vendo-density-control-height, 38px)",
  border: `1px solid ${t.border}`,
  borderRadius: t.radiusSmall,
  background: t.surface,
  padding: "var(--vendo-density-control-padding, 9px 12px)",
};

/** Recharts-friendly categorical palette derived from the host accent. */
export const chartSeries = [
  t.accent,
  "color-mix(in srgb, var(--vendo-color-accent, #111111) 55%, var(--vendo-color-surface, #ffffff))",
  "color-mix(in srgb, var(--vendo-color-accent, #111111) 30%, var(--vendo-color-surface, #ffffff))",
  "var(--vendo-color-muted, #6b6b76)",
  "color-mix(in srgb, var(--vendo-color-danger, #c62f2f) 70%, var(--vendo-color-accent, #111111))",
] as const;

/** Nth series color, wrapping. */
export function seriesColor(index: number): string {
  return chartSeries[index % chartSeries.length]!;
}
