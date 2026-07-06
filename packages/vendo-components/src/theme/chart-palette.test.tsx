/**
 * Chart palettes must reach OpenUI's charts WITHOUT tripping ThemeProvider's
 * dev validation. OpenUI's `Theme` TYPE includes the `*ChartPalette` keys
 * (ChartColorPalette in ThemeProvider/types.d.ts), but its runtime validator
 * derives "known keys" from the default theme object — which carries none of
 * them — so passing palettes through `lightTheme`/`darkTheme` spammed
 * "[OpenUI] lightTheme contains unknown key 'barChartPalette'…" ten times per
 * page (browser-observed in both demo apps). The fix routes palettes around
 * the validated prop and re-provides them on OpenUI's ThemeContext, so
 * `useChartPalette` still finds them and the console stays clean.
 *
 * NOTE: OpenUI's warnOnce dedupes per module load, so the no-warning
 * assertion must run FIRST in this file (vitest isolates per test file).
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useTheme } from "../openui.js";
import { VendoThemeProvider } from "./VendoThemeProvider.js";
import { defaultBrand } from "./brand.js";
import { brandToChartPalette } from "./brand-to-chart-palette.js";
import { mapBrandToTheme } from "./map-brand-to-theme.js";
import { splitChartPalettes } from "./chart-palette-bridge.js";

function probeTheme(): Record<string, unknown> {
  let seen: Record<string, unknown> = {};
  function Probe() {
    seen = useTheme().theme as Record<string, unknown>;
    return null;
  }
  render(
    <VendoThemeProvider brand={defaultBrand}>
      <Probe />
    </VendoThemeProvider>,
  );
  return seen;
}

describe("chart palettes through the OpenUI theme", () => {
  it("mounts without any '[OpenUI] … unknown key' console spam", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      probeTheme();
      const openuiWarnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("unknown key"));
      expect(openuiWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still delivers every brand chart palette to OpenUI's theme context (useChartPalette's source)", () => {
    const theme = probeTheme();
    const palette = brandToChartPalette(defaultBrand);
    for (const key of [
      "defaultChartPalette",
      "barChartPalette",
      "lineChartPalette",
      "areaChartPalette",
      "pieChartPalette",
    ]) {
      expect(theme[key], key).toEqual(palette);
    }
  });

  it("splitChartPalettes separates palette keys from the CSS-token theme", () => {
    const full = mapBrandToTheme(defaultBrand);
    const { theme, palettes } = splitChartPalettes(full);
    expect(Object.keys(theme)).not.toContain("barChartPalette");
    expect(palettes["barChartPalette"]).toEqual(brandToChartPalette(defaultBrand));
    // Non-palette tokens survive untouched.
    expect(theme.background).toBe(full.background);
  });
});
