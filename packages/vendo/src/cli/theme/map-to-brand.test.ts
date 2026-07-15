import { describe, expect, it } from "vitest";
import type { CssVarDecl } from "./css-vars.js";
import { mapVarsToBrand } from "./map-to-brand.js";

function vars(values: Record<string, string>): CssVarDecl[] {
  return Object.entries(values).map(([name, value]) => ({
    name,
    value,
    file: "tokens.css",
    darkScope: false,
  }));
}

describe("mapVarsToBrand full VendoTheme slots", () => {
  it("fills every new slot with fail-closed defaults when host evidence is absent", () => {
    const result = mapVarsToBrand([]);
    expect(result.slots).toMatchObject({
      border: "#e2e8f0",
      danger: "#dc2626",
      accentText: "#ffffff",
      headingFamily: "system-ui, sans-serif",
      density: "comfortable",
      motion: "full",
    });
    expect(result.defaulted).toEqual(expect.arrayContaining([
      "border", "danger", "headingFamily", "density", "motion",
    ]));
  });

  it("uses an explicit muted token before falling back to an ink-soft convention", () => {
    expect(mapVarsToBrand(vars({
      "--color-muted": "#908c85",
      "--color-ink-soft": "#46443f",
    })).slots.mutedText).toBe("#908c85");
    expect(mapVarsToBrand(vars({ "--color-ink-soft": "#5c554b" })).slots.mutedText).toBe("#5c554b");
  });

  it("uses the conventional 600 step for a single declared brand scale", () => {
    expect(mapVarsToBrand(vars({
      "--color-evergreen-100": "#d8ebe2",
      "--color-evergreen-500": "#34816a",
      "--color-evergreen-600": "#266755",
      "--color-evergreen-900": "#16362e",
    })).slots.accent).toBe("#266755");
  });

  it("maps explicit border and danger tokens without confusing status backgrounds", () => {
    const result = mapVarsToBrand(vars({
      "--color-border": "#e7e5e4",
      "--color-border-strong": "#d6d3d1",
      "--color-danger": "#b91c1c",
      "--color-danger-bg": "#fee2e2",
    }));

    expect(result.slots.border).toBe("#e7e5e4");
    expect(result.slots.danger).toBe("#b91c1c");
    expect(result.matched).toMatchObject({ border: "--color-border", danger: "--color-danger" });

    const ambiguous = mapVarsToBrand(vars({
      "--color-danger-bg": "#fee2e2",
      "--color-danger-foreground": "#7f1d1d",
    }));
    expect(ambiguous.slots.danger).toBe("#dc2626");
    expect(ambiguous.defaulted).toContain("danger");
  });

  it("uses an explicit accent text token, otherwise chooses the higher WCAG contrast", () => {
    const explicit = mapVarsToBrand(vars({
      "--primary": "#facc15",
      "--primary-foreground": "#422006",
    }));
    expect(explicit.slots.accentText).toBe("#422006");
    expect(explicit.matched.accentText).toBe("--primary-foreground");

    expect(mapVarsToBrand(vars({ "--primary": "#facc15" })).slots.accentText).toBe("#000000");
    expect(mapVarsToBrand(vars({ "--primary": "#1d4ed8" })).slots.accentText).toBe("#ffffff");
  });

  it("maps a declared heading family and otherwise inherits the resolved body stack", () => {
    const explicit = mapVarsToBrand(vars({
      "--font-sans": "Inter, sans-serif",
      "--font-heading": "Newsreader, serif",
    }));
    expect(explicit.slots.headingFamily).toBe("Newsreader, serif");
    expect(explicit.matched.headingFamily).toBe("--font-heading");

    const inherited = mapVarsToBrand(vars({ "--font-sans": "Inter, sans-serif" }));
    expect(inherited.slots.headingFamily).toBe("Inter, sans-serif");
    expect(inherited.matched.headingFamily).toBe("(inherit) fontFamily");

    const headingOnly = mapVarsToBrand(vars({ "--font-heading": "Newsreader, serif" }));
    expect(headingOnly.slots.fontFamily).toBe("system-ui, sans-serif");
    expect(headingOnly.slots.headingFamily).toBe("Newsreader, serif");
  });

  it("infers compact density only from strong base-size or explicit density signals", () => {
    expect(mapVarsToBrand(vars({ "--font-size": "14px" })).slots.density).toBe("compact");
    expect(mapVarsToBrand(vars({ "--density": "compact" })).slots.density).toBe("compact");
    expect(mapVarsToBrand(vars({ "--font-size": "16px" })).slots.density).toBe("comfortable");
    expect(mapVarsToBrand([]).defaulted).toContain("density");
  });

  it("maps explicit reduced motion and non-zero transition duration signals", () => {
    expect(mapVarsToBrand(vars({ "--motion": "reduced" })).slots.motion).toBe("reduced");
    expect(mapVarsToBrand(vars({ "--transition-duration": "0ms" })).slots.motion).toBe("reduced");
    const full = mapVarsToBrand(vars({ "--transition-duration": "150ms" }));
    expect(full.slots.motion).toBe("full");
    expect(full.matched.motion).toBe("--transition-duration");
    expect(mapVarsToBrand([]).defaulted).toContain("motion");
  });
});
