/**
 * Shared style tokens for the Kit. Every value resolves to a host `--vendo-*`
 * theme variable with a porcelain default — so a Kit component is brand-native
 * on any host and never hardcodes Vendo's own brand (W2 §The Kit, axis 1).
 */
import {
  defaultVendoTheme,
} from "@vendoai/apps/contract";
import type { CSSProperties } from "react";

/** Every fallback is READ OFF `defaultVendoTheme` rather than retyped, because
 * the retyped copy had drifted: surface and background were swapped (an
 * unthemed Kit painted a white page with off-white cards INVERTED), and
 * fontFamily had lost the brand stack. */
const d = defaultVendoTheme;

export const t = {
  text: `var(--vendo-color-text, ${d.colors.text})`,
  muted: `var(--vendo-color-muted, ${d.colors.muted})`,
  surface: `var(--vendo-color-surface, ${d.colors.surface})`,
  background: `var(--vendo-color-background, ${d.colors.background})`,
  accent: `var(--vendo-color-accent, ${d.colors.accent})`,
  accentText: `var(--vendo-color-accent-text, ${d.colors.accentText})`,
  danger: `var(--vendo-color-danger, ${d.colors.danger})`,
  border: `var(--vendo-color-border, ${d.colors.border})`,
  radiusSmall: `var(--vendo-radius-small, ${d.radius.small})`,
  radiusMedium: `var(--vendo-radius-medium, ${d.radius.medium})`,
  radiusLarge: `var(--vendo-radius-large, ${d.radius.large})`,
  fontFamily: `var(--vendo-font-family, ${d.typography.fontFamily})`,
  headingFamily: `var(--vendo-heading-family, var(--vendo-font-family, ${d.typography.fontFamily}))`,
  fontSize: `var(--vendo-font-size, ${d.typography.baseSize})`,
  motionDuration: "var(--vendo-motion-duration, 160ms)",
  motionEasing: "var(--vendo-motion-easing, cubic-bezier(0.2, 0.8, 0.2, 1))",
} as const;

/**
 * The Kit's type scale, as multipliers of the host's base size — ORDERED, and
 * the order is the point: one thing leads a screen. The headline is the largest
 * text on it, above a Stat's value, above a section's Card/Surface title, above
 * body (1). The scale used to be flat (a headline rendered at BODY size with a
 * heavier weight, a Stat's value at 1.65×), so the biggest thing on a generated
 * screen was whichever Stat tile happened to sit there, and a screen with two or
 * three of them had nothing leading at all.
 */
export const typeScale = {
  headline: 1.8,
  statValue: 1.35,
  cardTitle: 1.08,
  surfaceTitle: 1.05,
} as const;

/** A type-scale step as a CSS font-size against the host's base. */
export function fontSizeAt(step: number): string {
  return `calc(var(--vendo-font-size, ${d.typography.baseSize}) * ${step})`;
}

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
  `color-mix(in srgb, ${t.accent} 55%, ${t.surface})`,
  `color-mix(in srgb, ${t.accent} 30%, ${t.surface})`,
  t.muted,
  `color-mix(in srgb, ${t.danger} 70%, ${t.accent})`,
] as const;

/** Nth series color, wrapping. */
export function seriesColor(index: number): string {
  return chartSeries[index % chartSeries.length]!;
}
