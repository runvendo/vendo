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

/**
 * Recharts-friendly categorical palette: a ramp down the host's own TEXT tone
 * toward its surface.
 *
 * A chart is decoration, and the accent is the host's one loud colour — spending
 * it on six bars leaves nothing left to say "press this", and a reader who has
 * learned that green means the primary action has to unlearn it per screen. The
 * old ramp led with `t.accent` and closed on a `danger`×`accent` mix, so a
 * six-category breakdown came out entirely brand green with one red-brown wedge
 * that read as an alert about a value that was merely small.
 *
 * Every step is a theme token, so the ramp inverts correctly on a dark host:
 * `t.text` is light there and `t.surface` is dark, and the steps still descend.
 */
export const chartSeries = [
  `color-mix(in srgb, ${t.text} 78%, ${t.surface})`,
  `color-mix(in srgb, ${t.text} 62%, ${t.surface})`,
  `color-mix(in srgb, ${t.text} 48%, ${t.surface})`,
  `color-mix(in srgb, ${t.text} 34%, ${t.surface})`,
  `color-mix(in srgb, ${t.text} 22%, ${t.surface})`,
] as const;

/** Nth series color, wrapping. */
export function seriesColor(index: number): string {
  return chartSeries[index % chartSeries.length]!;
}

/**
 * The colour a formatted amount is printed in: the theme's danger tone when the
 * amount is a negative sum of money, otherwise the ambient text colour.
 *
 * A debit that reads exactly like a credit is the most expensive kind of
 * identical: `-$1,288.40` and `$1,288.40` differ by one glyph at the far left of
 * a right-aligned column. Every Kit surface that prints money asks this, so the
 * sign is legible without the writer having to remember a tone prop.
 */
export function amountColor(value: unknown, format: string | undefined): string | undefined {
  return format === "money" && typeof value === "number" && value < 0 ? t.danger : undefined;
}
