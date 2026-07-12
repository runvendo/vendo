import { describe, it, expect } from "vitest";
import { brandToChartPalette } from "./brand-to-chart-palette.js";
import { mapBrandToTheme } from "./map-brand-to-theme.js";
import { defaultBrand, type BrandTokens } from "./brand.js";

const maple: BrandTokens = {
  version: 1,
  accent: "#1B1C22",
  background: "#F4F3F0",
  surface: "#FFFFFF",
  text: "#14151A",
  mutedText: "#8A8B92",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  radius: "16px",
  mode: "light",
};

describe("brandToChartPalette", () => {
  it("derives a categorical palette of literal hex colors from the brand tokens", () => {
    const palette = brandToChartPalette(maple);
    expect(palette.length).toBeGreaterThanOrEqual(5);
    for (const c of palette) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("leads with the accent and contains no duplicate colors", () => {
    const palette = brandToChartPalette(maple);
    expect(palette[0].toLowerCase()).toBe("#1b1c22");
    expect(new Set(palette.map((c) => c.toLowerCase())).size).toBe(palette.length);
  });

  it("is deterministic for the same brand", () => {
    expect(brandToChartPalette(maple)).toEqual(brandToChartPalette(maple));
  });

  it("inherits brand character: a chromatic accent yields chromatic leading colors", () => {
    const blue: BrandTokens = { ...defaultBrand, accent: "#0A7CFF" };
    const palette = brandToChartPalette(blue);
    // First two entries derive from the accent — they must not be gray
    // (equal r/g/b would mean the brand hue was dropped).
    for (const c of palette.slice(0, 2)) {
      const [r, g, b] = [c.slice(1, 3), c.slice(3, 5), c.slice(5, 7)].map((x) => parseInt(x, 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(10);
    }
  });
});

describe("mapBrandToTheme chart + surface completeness", () => {
  it("feeds the derived palette into every OpenUI chart palette slot", () => {
    const theme = mapBrandToTheme(maple);
    const palette = brandToChartPalette(maple);
    expect(theme.defaultChartPalette).toEqual(palette);
    expect(theme.barChartPalette).toEqual(palette);
    expect(theme.lineChartPalette).toEqual(palette);
    expect(theme.areaChartPalette).toEqual(palette);
    expect(theme.pieChartPalette).toEqual(palette);
  });

  it("maps foreground (a SURFACE role in OpenUI) and derived surface/highlight fields", () => {
    const theme = mapBrandToTheme(maple);
    expect(theme.foreground).toBe(maple.surface);
    expect(theme.sunk).toBeTruthy();
    expect(theme.elevatedStrong).toBeTruthy();
    expect(theme.highlightSubtle).toBeTruthy();
    expect(theme.textNeutralLink).toBe(maple.accent);
  });
});
