import { useMemo, type ReactNode } from "react";
import { ThemeProvider } from "@openuidev/react-ui";
import { type BrandTokens, defaultBrand } from "./brand.js";
import { mapBrandToTheme } from "./map-brand-to-theme.js";
import { ChartPaletteBridge, splitChartPalettes } from "./chart-palette-bridge.js";

export interface VendoThemeProviderProps {
  brand?: BrandTokens;
  children: ReactNode;
}

/** Wraps OpenUI's ThemeProvider, mapping host brand tokens to its Theme.
 *  Chart palettes ride the ChartPaletteBridge instead of the validated
 *  lightTheme/darkTheme props (see chart-palette-bridge.tsx). */
export function VendoThemeProvider({ brand = defaultBrand, children }: VendoThemeProviderProps) {
  const { theme, palettes } = useMemo(() => splitChartPalettes(mapBrandToTheme(brand)), [brand]);
  const mode = brand.mode ?? "light";
  return (
    <ThemeProvider mode={mode} lightTheme={theme} darkTheme={theme}>
      <ChartPaletteBridge palettes={palettes}>{children}</ChartPaletteBridge>
    </ThemeProvider>
  );
}
