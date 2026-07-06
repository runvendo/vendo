/**
 * Chart palettes must actually COLOR OpenUI's charts with the host brand — not
 * merely land on a theme object. OpenUI 0.12.1's charts resolve their series
 * colors through `useChartPalette` (dist components/Charts/utils/PalletUtils.js),
 * which reads `useTheme().theme[themePaletteName] || .defaultChartPalette` — and
 * `useTheme` is `useContext(ThemeContext)` (dist ThemeProvider/ThemeProvider.js),
 * a plain React context, NOT a separate store. But the `*ChartPalette` keys are
 * absent from OpenUI's default theme, so its ThemeProvider's dev validator both
 * warns "unknown key '…ChartPalette'" AND drops them when they ride the
 * `lightTheme`/`darkTheme` props. `ChartPaletteBridge` therefore peels the
 * palette keys off the validated prop and re-provides them on that same
 * ThemeContext, where `useChartPalette` still finds them.
 *
 * These tests render a REAL OpenUI `BarChart` and assert the brand palette
 * reaches the rendered DOM (recharts emits the series colors as CSS-var hexes
 * in a ChartStyle <style> block + legend swatches, so the colors are present
 * even though jsdom gives recharts no layout). A negative control renders the
 * same chart with no provider and asserts it falls back to OpenUI's "ocean"
 * defaults — proving the assertion discriminates brand colors from defaults.
 * Both mount paths are covered: host chrome (VendoThemeProvider) and the
 * sandbox theme wrap (installVendoHost's __VENDO_THEME_WRAP__).
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { BarChart, useTheme } from "../openui.js";
import { installVendoHost } from "../sandbox-install.js";
import { VendoThemeProvider } from "./VendoThemeProvider.js";
import { defaultBrand } from "./brand.js";
import { brandToChartPalette } from "./brand-to-chart-palette.js";
import { mapBrandToTheme } from "./map-brand-to-theme.js";
import { splitChartPalettes } from "./chart-palette-bridge.js";

const CHART_DATA = [
  { month: "Jan", a: 10, b: 20, c: 30, d: 40, e: 50, f: 60 },
  { month: "Feb", a: 15, b: 25, c: 35, d: 45, e: 55, f: 65 },
];

/** OpenUI's built-in "ocean" default palette (dist Charts/utils/PalletUtils.js)
 *  — what a chart falls back to when no brand palette reaches it. */
const OCEAN_DEFAULTS = ["#0d47a1", "#1565c0", "#1976d2", "#1e88e5", "#2196f3", "#42a5f5"];

function chart(): React.ReactElement {
  return (
    <BarChart
      data={CHART_DATA}
      categoryKey="month"
      width={600}
      height={300}
      isAnimationActive={false}
    />
  );
}

/** Lower-cased #rrggbb hex colors present anywhere in a rendered subtree. */
function hexesIn(node: HTMLElement): string[] {
  return node.innerHTML.toLowerCase().match(/#[0-9a-f]{6}/g) ?? [];
}

describe("brand chart palettes reach OpenUI charts", () => {
  it("host path: a BarChart under VendoThemeProvider renders in the brand palette, not OpenUI defaults", () => {
    const { container } = render(<VendoThemeProvider brand={defaultBrand}>{chart()}</VendoThemeProvider>);
    const hexes = new Set(hexesIn(container));
    const brand = brandToChartPalette(defaultBrand);
    // Every brand series color is present; no OpenUI "ocean" default leaks in.
    for (const c of brand) expect(hexes, c).toContain(c);
    for (const c of OCEAN_DEFAULTS) expect(hexes, c).not.toContain(c);
  });

  it("negative control: the same chart with NO provider falls back to OpenUI's ocean defaults", () => {
    const { container } = render(chart());
    const hexes = new Set(hexesIn(container));
    const brand = brandToChartPalette(defaultBrand);
    // Proves the host-path assertion discriminates: without the bridge the
    // chart shows ocean defaults and none of the brand colors.
    expect(OCEAN_DEFAULTS.some((c) => hexes.has(c))).toBe(true);
    for (const c of brand) expect(hexes, c).not.toContain(c);
  });

  it("sandbox path: __VENDO_THEME_WRAP__ colors a BarChart with the brand palette", () => {
    installVendoHost();
    const wrap = window.__VENDO_THEME_WRAP__;
    expect(wrap).toBeTypeOf("function");
    const wrapped = wrap!({ mode: "light", theme: mapBrandToTheme(defaultBrand) }, chart());
    const { container } = render(wrapped as React.ReactElement);
    const hexes = new Set(hexesIn(container));
    const brand = brandToChartPalette(defaultBrand);
    for (const c of brand) expect(hexes, c).toContain(c);
    for (const c of OCEAN_DEFAULTS) expect(hexes, c).not.toContain(c);
  });

  it("dark mode still delivers the brand palette to a chart", () => {
    const darkBrand = { ...defaultBrand, mode: "dark" as const };
    const { container } = render(<VendoThemeProvider brand={darkBrand}>{chart()}</VendoThemeProvider>);
    const hexes = new Set(hexesIn(container));
    for (const c of brandToChartPalette(darkBrand)) expect(hexes, c).toContain(c);
  });

  it("mounts without any '[OpenUI] … unknown key' console spam", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(
        <VendoThemeProvider brand={defaultBrand}>
          <span />
        </VendoThemeProvider>,
      );
      const unknownKeyWarnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("unknown key"));
      expect(unknownKeyWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still delivers every brand chart palette on OpenUI's theme context (useChartPalette's source)", () => {
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
    const palette = brandToChartPalette(defaultBrand);
    for (const key of [
      "defaultChartPalette",
      "barChartPalette",
      "lineChartPalette",
      "areaChartPalette",
      "pieChartPalette",
    ]) {
      expect(seen[key], key).toEqual(palette);
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
