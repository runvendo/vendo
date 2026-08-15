/**
 * Theme v2 — the fields added after the original eight-color shape.
 *
 * Two properties hold the whole thing up. (1) Every addition is OPTIONAL: the
 * parser discards the WHOLE theme file on one bad field, so a required addition
 * would blank the brand of every host whose theme predates it. (2) The mapping
 * emits ONE fixed set of variable NAMES regardless — the door, the MCP Apps shim
 * and the chrome compare that set against each other, and the shim's reverse
 * read throws on a name outside it, so a name that appears only for some themes
 * is a live bug on three surfaces.
 */
import { describe, expect, it } from "vitest";
import { vendoThemeSchema } from "../../src/contract/catalog.js";
import {
  VENDO_THEME_VARIABLE_NAMES,
  chartPaletteFor,
  themeCssVariables,
  themeDefaults,
} from "../../src/contract/theme.js";

/** A theme written before any of the v2 fields existed. */
const preV2 = {
  colors: {
    background: "#ffffff",
    surface: "#f7f7f7",
    text: "#111111",
    muted: "#666666",
    accent: "#0055ff",
    accentText: "#ffffff",
    danger: "#cc0000",
    border: "#dddddd",
  },
  typography: { fontFamily: "Inter", baseSize: "16px" },
  radius: { small: "4px", medium: "8px", large: "16px" },
  density: "comfortable" as const,
  motion: "full" as const,
};

describe("theme v2 — the additions never break an older theme", () => {
  it("a theme carrying none of the new fields still parses", () => {
    expect(vendoThemeSchema.safeParse(preV2).success).toBe(true);
  });

  it("…and a theme carrying all of them parses too", () => {
    expect(vendoThemeSchema.safeParse({
      ...preV2,
      colors: { ...preV2.colors, success: "#0a0", warning: "#fa0", surfaceRaised: "#eee" },
      typography: {
        ...preV2.typography,
        monoFamily: "Berkeley Mono, monospace",
        weightNormal: "350",
        weightEmphasis: "650",
        letterSpacing: "0.01em",
        lineHeightBody: "1.6",
        lineHeightHeading: "1.2",
      },
      shadow: { small: "0 1px 2px #0001", medium: "0 4px 8px #0002", large: "0 20px 40px #0003" },
      borderWidth: "2px",
      chartPalette: ["#111", "#222"],
      motionDuration: "90ms",
      motionEasing: "linear",
    }).success).toBe(true);
  });

  it("emits the same variable NAMES for a pre-v2 theme as for a full one", () => {
    const full = { ...preV2, borderWidth: "2px", chartPalette: ["#111"], motionEasing: "linear" };
    expect(Object.keys(themeCssVariables(preV2))).toEqual(Object.keys(themeCssVariables(full)));
    // …and that set is the published list, minus the one name a host either
    // declares or does not.
    expect(Object.keys(themeCssVariables(preV2)))
      .toEqual(VENDO_THEME_VARIABLE_NAMES.filter((name) => name !== "--vendo-heading-family"));
  });
});

describe("theme v2 — the new variables carry the new fields", () => {
  it("a pre-v2 theme still gets every new variable, at its default", () => {
    const vars = themeCssVariables(preV2);
    expect(vars["--vendo-color-success"]).toBe(themeDefaults.colors.success);
    expect(vars["--vendo-color-warning"]).toBe(themeDefaults.colors.warning);
    expect(vars["--vendo-color-surface-raised"]).toContain("color-mix(");
    expect(vars["--vendo-mono-family"]).toBe(themeDefaults.typography.monoFamily);
    expect(vars["--vendo-font-weight-normal"]).toBe("400");
    expect(vars["--vendo-font-weight-emphasis"]).toBe("600");
    expect(vars["--vendo-letter-spacing"]).toBe("-0.011em");
    expect(vars["--vendo-line-height"]).toBe("1.5");
    expect(vars["--vendo-line-height-heading"]).toBe("1.3");
    expect(vars["--vendo-shadow-medium"]).toBe(themeDefaults.shadow.medium);
    expect(vars["--vendo-border-width"]).toBe("1px");
    expect(vars["--vendo-motion-easing"]).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
  });

  it("a host's own values win, field by field", () => {
    const vars = themeCssVariables({
      ...preV2,
      colors: { ...preV2.colors, success: "#00aa55" },
      typography: { ...preV2.typography, weightEmphasis: "800", lineHeightBody: "1.7" },
      shadow: { small: "none", medium: "0 4px 8px #0002", large: "0 20px 40px #0003" },
      borderWidth: "2px",
      motionDuration: "90ms",
      motionEasing: "linear",
    });
    expect(vars["--vendo-color-success"]).toBe("#00aa55");
    expect(vars["--vendo-font-weight-emphasis"]).toBe("800");
    expect(vars["--vendo-line-height"]).toBe("1.7");
    expect(vars["--vendo-shadow-small"]).toBe("none");
    expect(vars["--vendo-border-width"]).toBe("2px");
    expect(vars["--vendo-motion-duration"]).toBe("90ms");
    expect(vars["--vendo-motion-easing"]).toBe("linear");
  });

  it("motion: reduced still zeroes the duration a host asked for", () => {
    const vars = themeCssVariables({ ...preV2, motion: "reduced", motionDuration: "90ms" });
    expect(vars["--vendo-motion-duration"]).toBe("0ms");
  });
});

describe("chartPalette — the host's series, else the accent ramp", () => {
  it("a host palette lands on --vendo-chart-1..n and the ramp fills the rest", () => {
    const vars = themeCssVariables({ ...preV2, chartPalette: ["#e11", "#1e1", "#11e"] });
    expect(vars["--vendo-chart-1"]).toBe("#e11");
    expect(vars["--vendo-chart-2"]).toBe("#1e1");
    expect(vars["--vendo-chart-3"]).toBe("#11e");
    expect(vars["--vendo-chart-4"]).toBe(chartPaletteFor(preV2.colors.accent)[3]);
  });

  it("a palette longer than six truncates, and the rest of the theme survives", () => {
    const parsed = vendoThemeSchema.safeParse({
      ...preV2,
      chartPalette: ["#1", "#2", "#3", "#4", "#5", "#6", "#7"],
    });
    expect(parsed.success && parsed.data.chartPalette).toEqual(["#1", "#2", "#3", "#4", "#5", "#6"]);
    expect(parsed.success && parsed.data.typography.fontFamily).toBe("Inter");
    expect(parsed.success && parsed.data.colors).toEqual(preV2.colors);
  });

  it("a palette of six or fewer is passed through untouched", () => {
    const six = ["#1", "#2", "#3", "#4", "#5", "#6"];
    const parsed = vendoThemeSchema.safeParse({ ...preV2, chartPalette: six });
    expect(parsed.success && parsed.data.chartPalette).toEqual(six);
  });

  it("no palette is the accent ramp, unchanged", () => {
    const vars = themeCssVariables(preV2);
    const ramp = chartPaletteFor(preV2.colors.accent);
    expect([1, 2, 3, 4, 5, 6].map((n) => vars[`--vendo-chart-${n}`])).toEqual(ramp.slice(0, 6));
    // The ramp itself: the accent, then hue-locked OKLCH steps off it.
    expect(ramp[0]).toBe("#0055ff");
    expect(ramp[1]).toBe("oklch(from #0055ff 0.7 calc(c * 0.9) h)");
  });
});
