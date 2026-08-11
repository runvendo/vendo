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
 * Series lightness ladder, as `[lightness, chroma scale]` in OKLCH. Absolute
 * lightness rather than `calc(l ± n)` because relative steps collapse for a
 * near-black or near-white accent (the default accent is #111111), and chroma
 * eases off as lightness rises so the pale steps stay in sRGB gamut. Ordered so
 * neighbouring series sit far apart on the ladder.
 */
const seriesRamp: ReadonlyArray<readonly [number, number]> = [
  [0.7, 0.9],
  [0.46, 1],
  [0.86, 0.5],
  [0.54, 1],
  [0.78, 0.65],
  [0.38, 1],
  [0.62, 0.95],
];

/**
 * Recharts-friendly categorical palette: the host accent, then shades and tints
 * of it that keep its hue (`h`) exactly — so a chart is brand-native on any host
 * and never invents a color. The old cycle reached for `muted` and a
 * danger×accent mix, which read as slate-purple and rust wedges on a green
 * brand.
 */
export const chartSeries = [
  t.accent,
  ...seriesRamp.map(([l, c]) => `oklch(from ${t.accent} ${l} calc(c * ${c}) h)`),
] as const;

/** Nth series color, wrapping. */
export function seriesColor(index: number): string {
  return chartSeries[index % chartSeries.length]!;
}
