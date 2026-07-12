/**
 * Route brand chart palettes AROUND OpenUI ThemeProvider's dev validation.
 *
 * OpenUI's `Theme` type includes the `*ChartPalette` keys and its charts read
 * them from the theme CONTEXT (`useChartPalette`: `theme[themePaletteName] ||
 * theme.defaultChartPalette`), but the ThemeProvider's dev-mode validator
 * derives its known-key set from the default theme object — which carries no
 * palette keys — so palettes passed via `lightTheme`/`darkTheme` warn
 * "[OpenUI] lightTheme contains unknown key '…ChartPalette'" on every mount.
 *
 * `splitChartPalettes` peels the palette keys off the theme handed to
 * ThemeProvider; `ChartPaletteBridge` then re-provides OpenUI's ThemeContext
 * with the palettes merged back into the resolved theme. Charts (and any
 * consumer of OpenUI's `useTheme`) see exactly the theme they saw before —
 * minus the console spam. Palette values are color ARRAYS consumed from
 * context, never CSS custom properties, so skipping `themeToCssVars` for
 * them loses nothing.
 */
import { useMemo, type ReactNode } from "react";
import { ThemeContext, useTheme, type Theme } from "@openuidev/react-ui";

const PALETTE_KEYS = [
  "defaultChartPalette",
  "barChartPalette",
  "lineChartPalette",
  "areaChartPalette",
  "pieChartPalette",
  "radarChartPalette",
  "radialChartPalette",
  "horizontalBarChartPalette",
] as const;

export type ChartPalettes = Partial<Pick<Theme, (typeof PALETTE_KEYS)[number]>>;

/** Split a Theme into its validator-safe tokens and its chart palettes. */
export function splitChartPalettes(full: Theme): { theme: Theme; palettes: ChartPalettes } {
  const theme: Record<string, unknown> = { ...(full as Record<string, unknown>) };
  const palettes: Record<string, unknown> = {};
  for (const key of PALETTE_KEYS) {
    if (key in theme) {
      if (theme[key] !== undefined) palettes[key] = theme[key];
      delete theme[key];
    }
  }
  return { theme: theme as Theme, palettes: palettes as ChartPalettes };
}

/** Mount INSIDE an OpenUI ThemeProvider: re-provides its ThemeContext with
 *  the chart palettes merged into the resolved theme. */
export function ChartPaletteBridge({
  palettes,
  children,
}: {
  palettes: ChartPalettes;
  /** Optional so `createElement(Bridge, props, children)` type-checks too. */
  children?: ReactNode;
}) {
  const ctx = useTheme();
  const value = useMemo(
    () => ({ ...ctx, theme: { ...ctx.theme, ...palettes } }),
    [ctx, palettes],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
