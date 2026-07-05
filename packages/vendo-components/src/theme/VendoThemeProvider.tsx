import type { ReactNode } from "react";
import { ThemeProvider } from "@openuidev/react-ui";
import { type BrandTokens, defaultBrand } from "./brand.js";
import { mapBrandToTheme } from "./map-brand-to-theme.js";

export interface VendoThemeProviderProps {
  brand?: BrandTokens;
  children: ReactNode;
}

/** Wraps OpenUI's ThemeProvider, mapping host brand tokens to its Theme. */
export function VendoThemeProvider({ brand = defaultBrand, children }: VendoThemeProviderProps) {
  const theme = mapBrandToTheme(brand);
  const mode = brand.mode ?? "light";
  return (
    <ThemeProvider mode={mode} lightTheme={theme} darkTheme={theme}>
      {children}
    </ThemeProvider>
  );
}
