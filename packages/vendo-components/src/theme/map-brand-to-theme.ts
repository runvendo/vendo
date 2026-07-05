import type { Theme } from "@openuidev/react-ui";
import type { BrandTokens } from "./brand";
import { brandToChartPalette } from "./brand-to-chart-palette";

/** color-mix() shorthand — OpenUI theme values land in CSS, where mixes are fine. */
const cm = (a: string, pct: number, b: string): string =>
  `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/**
 * Map Vendo brand tokens onto the OpenUI Theme object (flat string fields).
 * Covers every field derivable from the 8 BrandTokens primitives: text,
 * surfaces (sunk/elevated ramps), interactive accent states, highlights,
 * fonts, radii, and the chart palettes. Fields with no sensible derivation
 * (status colors, spacing scale, font sizes) keep OpenUI's defaults.
 */
export function mapBrandToTheme(brand: BrandTokens): Theme {
  const radius = typeof brand.radius === "number" ? `${brand.radius}px` : brand.radius;
  const chartPalette = brandToChartPalette(brand);
  return {
    // Core surfaces + text. NOTE: OpenUI's `foreground` is a SURFACE role (the
    // card/panel surface above `background` — light default is neutral-25),
    // not a text color; text roles are the textNeutral* fields below.
    background: brand.background,
    foreground: brand.surface,
    popoverBackground: brand.surface,
    sunkLight: cm(brand.background, 50, brand.surface),
    sunk: brand.background,
    sunkDeep: cm(brand.text, 6, brand.background),
    elevatedLight: cm(brand.surface, 60, brand.background),
    elevated: brand.surface,
    elevatedStrong: brand.surface,
    elevatedIntense: brand.surface,
    highlightSubtle: cm(brand.accent, 6, brand.surface),
    highlight: cm(brand.accent, 10, brand.surface),
    highlightStrong: cm(brand.accent, 16, brand.surface),
    highlightIntense: cm(brand.accent, 24, brand.surface),
    invertedBackground: brand.text,
    // Text roles
    textNeutralPrimary: brand.text,
    textNeutralSecondary: brand.mutedText,
    textNeutralTertiary: cm(brand.mutedText, 70, brand.surface),
    textNeutralLink: brand.accent,
    textBrand: brand.accent,
    textAccentPrimary: brand.accent,
    textAccentSecondary: cm(brand.accent, 75, brand.surface),
    textAccentTertiary: cm(brand.accent, 55, brand.surface),
    // Interactive accent states
    interactiveAccentDefault: brand.accent,
    interactiveAccentHover: cm(brand.accent, 88, brand.text),
    interactiveAccentPressed: cm(brand.accent, 78, brand.text),
    borderAccent: brand.accent,
    // Typography + radii
    fontBody: brand.fontFamily,
    fontHeading: brand.fontFamily,
    fontLabel: brand.fontFamily,
    fontNumbers: brand.fontFamily,
    radiusS: radius,
    radiusM: radius,
    radiusL: radius,
    // Charts — one brand-derived categorical palette for every chart type
    defaultChartPalette: chartPalette,
    barChartPalette: chartPalette,
    lineChartPalette: chartPalette,
    areaChartPalette: chartPalette,
    pieChartPalette: chartPalette,
  };
}
