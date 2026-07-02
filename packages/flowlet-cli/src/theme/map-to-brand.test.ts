import { describe, expect, it } from "vitest";
import { mapVarsToBrand } from "./map-to-brand.js";
import type { CssVarDecl } from "./css-vars.js";

const v = (name: string, value: string, darkScope = false): CssVarDecl => ({ name, value, file: "globals.css", darkScope });

describe("mapVarsToBrand", () => {
  it("maps demo-bank's @theme vars onto BrandTokens slots", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FBFBFA"), v("--color-surface", "#FFFFFF"), v("--color-ink", "#111111"),
      v("--color-ink-soft", "#46443F"), v("--color-muted", "#908C85"), v("--color-border", "#ECEBE8"),
      v("--radius-card", "14px"), v("--font-sans", "var(--font-inter)"),
    ]);
    expect(result.brand).toMatchObject({
      version: 1,
      background: "#FBFBFA",
      surface: "#FFFFFF",
      text: "#111111",
      mutedText: "#908C85",
      radius: "14px",
      mode: "light",
    });
    // no accent-ish var exists — defaulted and reported
    expect(result.defaulted).toContain("accent");
    // var(--font-inter) is unresolvable from CSS (next/font injects it at
    // runtime) — the frozen theme contract wants fully-resolved primitives,
    // so the font defaults instead of leaking a var() ref
    expect(result.defaulted).toContain("fontFamily");
    expect(result.brand?.fontFamily).not.toContain("var(");
    expect(result.unmapped.map((u) => u.name)).toContain("--color-border");
  });

  it("resolves var() chains for fonts and rejects unresolvable or unsafe values", () => {
    const resolved = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"),
      v("--font-inter", "Inter, sans-serif"),
      v("--font-sans", "var(--font-inter)"),
    ]);
    expect(resolved.brand?.fontFamily).toBe("Inter, sans-serif");

    const fallback = mapVarsToBrand([v("--color-bg", "#FFFFFF"), v("--font-sans", "var(--missing, Georgia, serif)")]);
    expect(fallback.brand?.fontFamily).toBe("Georgia, serif");

    const injection = mapVarsToBrand([v("--color-bg", "#FFFFFF"), v("--font-sans", "serif; } body { display:none")]);
    expect(injection.defaulted).toContain("fontFamily");
  });

  it("prefers accent-named vars and rejects non-hex colors", () => {
    const result = mapVarsToBrand([
      v("--color-primary", "oklch(0.7 0.1 250)"), v("--color-accent", "#FF0000"), v("--color-bg", "#FFFFFF"),
    ]);
    expect(result.brand?.accent).toBe("#FF0000");
    expect(result.unmapped.map((u) => u.name)).toContain("--color-primary");
  });

  it("flags a dark variant when dark-scoped vars exist", () => {
    const result = mapVarsToBrand([v("--color-bg", "#FFFFFF"), v("--color-bg", "#000000", true)]);
    expect(result.hasDarkVariant).toBe(true);
    expect(result.brand?.mode).toBe("light");
  });
});
