import type { ReactNode } from "react";
import { ThemeProvider } from "@openuidev/react-ui";
import { type BrandTokens, defaultBrand } from "./brand";
import { mapBrandToTheme } from "./map-brand-to-theme";

export interface FlowletThemeProviderProps {
  brand?: BrandTokens;
  children: ReactNode;
}

/** Wraps OpenUI's ThemeProvider, mapping host brand tokens to its Theme. */
export function FlowletThemeProvider({ brand = defaultBrand, children }: FlowletThemeProviderProps) {
  const theme = mapBrandToTheme(brand);
  const mode = brand.mode ?? "light";
  return (
    <ThemeProvider mode={mode} lightTheme={theme} darkTheme={theme}>
      {children}
    </ThemeProvider>
  );
}
