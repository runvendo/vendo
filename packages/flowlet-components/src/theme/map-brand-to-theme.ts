import type { Theme } from "@openuidev/react-ui";
import type { BrandTokens } from "./brand";

/** Map Flowlet brand tokens onto the OpenUI Theme object (flat string fields). */
export function mapBrandToTheme(brand: BrandTokens): Theme {
  const radius = `${brand.radius}px`;
  return {
    background: brand.background,
    elevated: brand.surface,
    sunk: brand.surface,
    popoverBackground: brand.surface,
    textNeutralPrimary: brand.text,
    textNeutralSecondary: brand.mutedText,
    textNeutralTertiary: brand.mutedText,
    textBrand: brand.accent,
    textAccentPrimary: brand.accent,
    interactiveAccentDefault: brand.accent,
    interactiveAccentHover: brand.accent,
    interactiveAccentPressed: brand.accent,
    borderAccent: brand.accent,
    fontBody: brand.fontFamily,
    fontHeading: brand.fontFamily,
    fontLabel: brand.fontFamily,
    fontNumbers: brand.fontFamily,
    radiusS: radius,
    radiusM: radius,
    radiusL: radius,
  };
}
