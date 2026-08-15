/**
 * Shared style tokens for the Kit. Every value resolves to a host `--vendo-*`
 * theme variable with a porcelain default — so a Kit component is brand-native
 * on any host and never hardcodes Vendo's own brand (W2 §The Kit, axis 1).
 */
import {
  chartPaletteFor,
  defaultVendoTheme,
  densityCssVariables,
  themeDefaults,
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
  success: `var(--vendo-color-success, ${themeDefaults.colors.success})`,
  warning: `var(--vendo-color-warning, ${themeDefaults.colors.warning})`,
  border: `var(--vendo-color-border, ${d.colors.border})`,
  // NOT `themeDefaults.colors.surfaceRaised`: that one mixes two `--vendo-*`
  // variables, which only resolve inside a host theme scope. Unthemed, they make
  // the whole `color-mix` invalid and the raised surface renders TRANSPARENT, so
  // the Kit's own fallback states the same one-step-off-surface mix in colors.
  surfaceRaised: `var(--vendo-color-surface-raised, color-mix(in srgb, ${d.colors.surface} 92%, ${d.colors.text}))`,
  radiusSmall: `var(--vendo-radius-small, ${d.radius.small})`,
  radiusMedium: `var(--vendo-radius-medium, ${d.radius.medium})`,
  radiusLarge: `var(--vendo-radius-large, ${d.radius.large})`,
  borderWidth: `var(--vendo-border-width, ${themeDefaults.borderWidth})`,
  shadowSmall: `var(--vendo-shadow-small, ${themeDefaults.shadow.small})`,
  fontFamily: `var(--vendo-font-family, ${d.typography.fontFamily})`,
  headingFamily: `var(--vendo-heading-family, var(--vendo-font-family, ${d.typography.fontFamily}))`,
  fontSize: `var(--vendo-font-size, ${d.typography.baseSize})`,
  weightNormal: `var(--vendo-font-weight-normal, ${themeDefaults.typography.weightNormal})`,
  weightEmphasis: `var(--vendo-font-weight-emphasis, ${themeDefaults.typography.weightEmphasis})`,
  letterSpacing: `var(--vendo-letter-spacing, ${themeDefaults.typography.letterSpacing})`,
  lineHeight: `var(--vendo-line-height, ${themeDefaults.typography.lineHeightBody})`,
  lineHeightHeading: `var(--vendo-line-height-heading, ${themeDefaults.typography.lineHeightHeading})`,
  motionDuration: "var(--vendo-motion-duration, 160ms)",
  motionEasing: "var(--vendo-motion-easing, cubic-bezier(0.2, 0.8, 0.2, 1))",
} as const;

/** The ONE edge a Kit component draws. Hairline and low-contrast: borders do the
 *  work that shadows used to, so almost nothing in the Kit is elevated. */
export const hairline = `${t.borderWidth} solid ${t.border}`;

/** Transition the named properties on the host's own motion pair. `motion:
 *  "reduced"` emits a 0ms duration, so this collapses to nothing with no branch. */
export const transitionFor = (...properties: string[]): string =>
  properties.map((p) => `${p} ${t.motionDuration} ${t.motionEasing}`).join(", ");

/** Figures line up by place value wherever the Kit prints one. */
export const numeric: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** The structural micro-label: a column header, a caption, a tile's metric name.
 *  Uppercase and letterspaced so it reads as chrome, never as content. */
export const microLabel: CSSProperties = {
  color: t.muted,
  fontSize: "0.72em",
  fontWeight: t.weightEmphasis,
  letterSpacing: "0.08em",
  lineHeight: t.lineHeight,
  textTransform: "uppercase",
};

/** Base text style shared by every Kit component. */
export const font: CSSProperties = {
  color: t.text,
  fontFamily: t.fontFamily,
  fontSize: t.fontSize,
  fontWeight: t.weightNormal,
  letterSpacing: t.letterSpacing,
  lineHeight: t.lineHeight,
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
  border: hairline,
  borderRadius: t.radiusSmall,
  background: t.surface,
  padding: "var(--vendo-density-control-padding, 9px 12px)",
  transition: transitionFor("border-color"),
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
 * Recharts-friendly categorical palette: the host's own `chartPalette`, which
 * the theme emits as `--vendo-chart-1..6`, falling back entry by entry to the
 * accent-derived ramp `chartPaletteFor` builds — so a chart is brand-native on
 * any host and never invents a color. The old cycle reached for `muted` and a
 * danger×accent mix, which read as slate-purple and rust wedges on a green
 * brand.
 */
export const chartSeries: readonly string[] = chartPaletteFor(t.accent)
  .map((color, i) => (i < 6 ? `var(--vendo-chart-${i + 1}, ${color})` : color));

/** Nth series color, wrapping. */
export function seriesColor(index: number): string {
  return chartSeries[index % chartSeries.length]!;
}
