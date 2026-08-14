/**
 * Shared style tokens for the Kit. Every value resolves to a host `--vendo-*`
 * theme variable with a porcelain default — so a Kit component is brand-native
 * on any host and never hardcodes Vendo's own brand (W2 §The Kit, axis 1).
 */
import {
  defaultVendoTheme,
  densityCssVariables,
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
  // Two tones the host contract does not carry a color for. They are still
  // TOKENS — a host that wants its own green and amber sets these two variables
  // — and the fallback is the green/amber the pill palette already used as a
  // literal, so nothing changes for a host that sets nothing.
  success: "var(--vendo-color-success, #1e7f53)",
  warning: "var(--vendo-color-warning, #d4a017)",
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
  // `width: 100%` with padding and a border overflows its column by 26px
  // unless the border-box is the thing being sized. The Kit renders inside a
  // host page it does not control, so it cannot assume a `* { box-sizing }`
  // reset is in force — every full-width Kit surface states it itself.
  boxSizing: "border-box",
  minWidth: 0,
  minHeight: "var(--vendo-density-control-height, 38px)",
  border: `1px solid ${t.border}`,
  borderRadius: t.radiusSmall,
  background: t.surface,
  padding: "var(--vendo-density-control-padding, 9px 12px)",
};

// ---------------------------------------------------------------------------
// The two adjectives (2026-08-13). One `tone` vocabulary and one `density`
// vocabulary, shared by every component that has an opinion about either, and
// resolving to nothing but the tokens above — so an adjective can never invent
// a color or a spacing step the host did not agree to.
// ---------------------------------------------------------------------------

/** The ONE tone vocabulary. Card/Stat's "default" and Callout's "info" are the
 *  older spellings of `neutral`; both still parse. */
export type KitTone = "neutral" | "accent" | "success" | "warning" | "danger";

/** The ONE density vocabulary — the host theme's own (`VendoTheme.density`). */
export type KitDensity = "comfortable" | "compact";

/** A tone's foreground, surface and border. Every entry is a token or a
 *  `color-mix` of tokens. */
export const toneStyle: Record<KitTone, { color: string; background: string; border: string }> = {
  neutral: {
    color: t.text,
    background: `color-mix(in srgb, ${t.muted} 10%, ${t.surface})`,
    border: t.border,
  },
  accent: { color: t.accentText, background: t.accent, border: t.accent },
  // Darkened against `text`, not against `#000`: a literal black is not a token,
  // and on a dark host theme it drove both foregrounds INTO the background.
  success: {
    color: `color-mix(in srgb, ${t.success} 88%, ${t.text})`,
    background: `color-mix(in srgb, ${t.success} 12%, ${t.surface})`,
    border: `color-mix(in srgb, ${t.success} 30%, ${t.border})`,
  },
  warning: {
    color: `color-mix(in srgb, ${t.warning} 72%, ${t.text})`,
    background: `color-mix(in srgb, ${t.warning} 16%, ${t.surface})`,
    border: `color-mix(in srgb, ${t.warning} 34%, ${t.border})`,
  },
  danger: {
    color: t.danger,
    background: `color-mix(in srgb, ${t.danger} 11%, ${t.surface})`,
    border: `color-mix(in srgb, ${t.danger} 30%, ${t.border})`,
  },
};

/** A tone's own color, for text and rules that carry a tone WITHOUT a pill —
 *  an emphasised Stat, a Card's border, a toned figure in a cell. Total like
 *  {@link resolveTone}, because this one is exported into code-land too and an
 *  unknown word must fall back rather than throw on `toneStyle[bogus].color`. */
export function toneColor(tone: string | undefined): string {
  const resolved = resolveTone(tone);
  return resolved === "accent" ? t.accent : toneStyle[resolved].color;
}

/**
 * Read a tone off a prop. Generated code passes arbitrary strings, so an
 * unknown word falls back rather than crashing (the Callout lesson,
 * 2026-07-26), and the two legacy spellings resolve to what they always meant.
 * `Object.hasOwn`, not a bare index: "constructor" is a string too.
 */
export function resolveTone(value: string | undefined, fallback: KitTone = "neutral"): KitTone {
  if (value === undefined) return fallback;
  if (value === "default" || value === "info") return "neutral";
  return Object.hasOwn(toneStyle, value) ? (value as KitTone) : fallback;
}

/**
 * The density scale as inline custom properties, so a container can re-declare
 * it for its own subtree. Every Kit component already reads its padding and
 * gaps from these variables, so setting them here is the WHOLE implementation
 * of `density` — nothing measures, nothing branches, and a component the
 * adjective was never taught about still gets denser.
 */
export function densityVars(density: KitDensity | undefined): CSSProperties {
  return density === undefined ? {} : (densityCssVariables(density) as CSSProperties);
}

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
