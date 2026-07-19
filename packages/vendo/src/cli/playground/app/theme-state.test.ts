import { vendoThemeSchema } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  curatedFonts,
  decodeThemeParam,
  encodeThemeParam,
  fontStack,
  googleFontHref,
  primaryFontFamily,
  themeJson,
  themePresets,
} from "./theme-state.js";

describe("theme presets", () => {
  it("leads with the Default black preset (Cadence-extracted tokens)", () => {
    expect(themePresets[0]!.name).toBe("Default black");
    expect(themePresets[0]!.theme.colors.accent).toBe("#111111");
    expect(themePresets[0]!.theme.colors.background).toBe("#fbfbfa");
  });

  it("every preset is a complete valid VendoTheme", () => {
    for (const preset of themePresets) {
      const parsed = vendoThemeSchema.safeParse(preset.theme);
      expect(parsed.success, preset.name).toBe(true);
    }
  });

  it("keeps Ultramarine blue even as the shipped default drifts", () => {
    const ultramarine = themePresets.find((preset) => preset.name === "Ultramarine");
    expect(ultramarine?.theme.colors.accent).toBe("#2f5af5");
  });

  it("includes a dark stress preset (background below the color-scheme flip)", () => {
    const dark = themePresets.find((preset) => preset.theme.colors.background === "#0f1116");
    expect(dark).toBeDefined();
    expect(dark!.theme.colors.surface).toBe("#171a21");
  });
});

describe("theme URL param codec", () => {
  it("round-trips every preset through encode/decode", () => {
    for (const preset of themePresets) {
      expect(decodeThemeParam(encodeThemeParam(preset.theme)), preset.name).toEqual(preset.theme);
    }
  });

  it("resolves a partial payload over the default theme", () => {
    const decoded = decodeThemeParam(JSON.stringify({ colors: { accent: "#ff0000" } }));
    expect(decoded?.colors.accent).toBe("#ff0000");
    // Untouched groups fall back to the shipped defaults.
    expect(vendoThemeSchema.safeParse(decoded).success).toBe(true);
  });

  it("rejects garbage: non-JSON, non-object, and null input", () => {
    expect(decodeThemeParam("not json")).toBeUndefined();
    expect(decodeThemeParam('"a string"')).toBeUndefined();
    expect(decodeThemeParam("[1,2]")).toBeUndefined();
    expect(decodeThemeParam(null)).toBeUndefined();
    expect(decodeThemeParam("")).toBeUndefined();
  });

  it("rejects payloads that break the VendoTheme shape", () => {
    expect(decodeThemeParam(JSON.stringify({ density: "spacious" }))).toBeUndefined();
    expect(decodeThemeParam(JSON.stringify({ colors: { accent: 7 } }))).toBeUndefined();
  });
});

describe("font helpers", () => {
  it("curates Onest, Inter, and a system stack", () => {
    expect(curatedFonts).toContain("Onest");
    expect(curatedFonts).toContain("Inter");
    expect(curatedFonts.some((font) => font.startsWith("system-ui"))).toBe(true);
  });

  it("extracts the primary family from a stack, unquoting it", () => {
    expect(primaryFontFamily("Inter, ui-sans-serif, system-ui, sans-serif")).toBe("Inter");
    expect(primaryFontFamily("'IBM Plex Sans', sans-serif")).toBe("IBM Plex Sans");
    expect(primaryFontFamily("system-ui, -apple-system, 'Segoe UI', sans-serif")).toBe("system-ui");
  });

  it("builds a Google Fonts css2 href for webfonts only", () => {
    expect(googleFontHref("Onest")).toBe("https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap");
    expect(googleFontHref("IBM Plex Sans")).toContain("family=IBM+Plex+Sans:");
    // Generic/system families never hit the network.
    expect(googleFontHref("system-ui")).toBeUndefined();
    expect(googleFontHref("sans-serif")).toBeUndefined();
    expect(googleFontHref("-apple-system")).toBeUndefined();
  });

  it("builds a full CSS stack, quoting multi-word families", () => {
    expect(fontStack("Onest")).toBe("Onest, system-ui, sans-serif");
    expect(fontStack("IBM Plex Sans")).toBe("'IBM Plex Sans', system-ui, sans-serif");
    expect(fontStack("system-ui")).toBe("system-ui, -apple-system, 'Segoe UI', sans-serif");
  });
});

describe("themeJson", () => {
  it("emits a pretty-printed valid .vendo/theme.json document", () => {
    const json = themeJson(themePresets[0]!.theme);
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain("\n  \"colors\"");
    expect(vendoThemeSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });
});
