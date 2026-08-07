import { describe, expect, it } from "vitest";
import { vendoThemeSchema } from "./catalog.js";

/** 01-core §14 — the brand-native theme the surface renders against. */
const theme = {
  colors: {
    background: "#fff",
    surface: "#f7f7f7",
    text: "#111",
    muted: "#666",
    accent: "#0055ff",
    accentText: "#fff",
    danger: "#c00",
    border: "#ddd",
  },
  typography: { fontFamily: "Inter", baseSize: "16px" },
  radius: { small: "4px", medium: "8px", large: "16px" },
  density: "comfortable" as const,
  motion: "full" as const,
};

describe("vendoThemeSchema", () => {
  it("accepts a full theme and one with the optional headingFamily", () => {
    expect(vendoThemeSchema.safeParse(theme).success).toBe(true);
    expect(
      vendoThemeSchema.safeParse({
        ...theme,
        typography: { ...theme.typography, headingFamily: "Newsreader" },
      }).success,
    ).toBe(true);
  });

  it("rejects a theme missing a required color", () => {
    const { border: _drop, ...missingBorder } = theme.colors;
    expect(vendoThemeSchema.safeParse({ ...theme, colors: missingBorder }).success).toBe(false);
  });

  it("constrains density and motion to their enums", () => {
    expect(vendoThemeSchema.safeParse({ ...theme, density: "cozy" }).success).toBe(false);
    expect(vendoThemeSchema.safeParse({ ...theme, motion: "none" }).success).toBe(false);
    expect(vendoThemeSchema.safeParse({ ...theme, density: "compact", motion: "reduced" }).success).toBe(true);
  });
});
