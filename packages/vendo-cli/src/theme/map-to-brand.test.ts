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

  it("skips companion -bg tokens and falls back to surface for background", () => {
    // Cadence-shaped: status tokens have paired *-bg tints, the real page
    // background is --color-surface, and cards are --color-card.
    const result = mapVarsToBrand([
      v("--color-surface", "#f7f5f1"), v("--color-card", "#ffffff"), v("--color-ink", "#221e19"),
      v("--color-status-missing", "#b45309"), v("--color-status-missing-bg", "#fdf0df"),
      v("--color-status-overdue", "#b91c1c"), v("--color-status-overdue-bg", "#fdeae8"),
    ]);
    expect(result.brand?.background).toBe("#f7f5f1");
    expect(result.matched["background"]).toBe("--color-surface");
    expect(result.brand?.surface).toBe("#ffffff");
    expect(result.matched["surface"]).toBe("--color-card");
  });

  it("treats X-fg/X-bg pairs as companions even without a bare X token", () => {
    const result = mapVarsToBrand([
      v("--color-surface", "#f7f5f1"), v("--color-card", "#ffffff"),
      v("--color-status-missing-fg", "#92400e"), v("--color-status-missing-bg", "#fef3c7"),
    ]);
    expect(result.brand?.background).toBe("#f7f5f1");
  });

  it("excludes companion tints from every slot, not just background", () => {
    // --color-panel is non-hex, so without the filter the surface slot's loose
    // "panel" match would claim the tint --color-panel-bg.
    const result = mapVarsToBrand([
      v("--color-bg", "#FBFBFA"), v("--color-panel", "oklch(0.98 0 0)"), v("--color-panel-bg", "#ffeedd"),
    ]);
    expect(result.defaulted).toContain("surface");
  });

  it("leaves a lone surface token to the surface slot instead of promoting it to background", () => {
    // Only one surface-ish token and nothing bg-named: claiming it for
    // background would leave BOTH slots wrong. Fail closed on background.
    const result = mapVarsToBrand([v("--color-surface", "#ffffff"), v("--color-ink", "#111111")]);
    expect(result.defaulted).toContain("background");
    expect(result.brand?.surface).toBe("#ffffff");
    expect(result.matched["surface"]).toBe("--color-surface");
  });

  it("does not pick synthetic (resolve-only) vars directly for a slot", () => {
    // next/font-derived vars exist to resolve var() chains; with no CSS font
    // token the font slot must default, not grab e.g. the mono family.
    const result = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"),
      { name: "--font-geist-mono", value: '"Geist Mono"', file: "layout.tsx", darkScope: false, synthetic: true },
      { name: "--font-geist-sans", value: '"Geist"', file: "layout.tsx", darkScope: false, synthetic: true },
    ]);
    expect(result.defaulted).toContain("fontFamily");
    expect(result.unmapped.map((u) => u.name)).not.toContain("--font-geist-mono");
  });

  it("rejects a low-chroma scale family as accent (fail-closed for unlisted neutrals)", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"),
      v("--color-sand-300", "#d6cfc2"), v("--color-sand-500", "#a49d8f"), v("--color-sand-700", "#6f695e"),
    ]);
    expect(result.defaulted).toContain("accent");
  });

  it("picks the mid step of a single scale-named accent family", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"),
      v("--color-evergreen-100", "#d8ebe2"), v("--color-evergreen-300", "#85bda8"),
      v("--color-evergreen-500", "#34816a"), v("--color-evergreen-700", "#205345"),
      v("--color-evergreen-900", "#16362e"),
    ]);
    expect(result.brand?.accent).toBe("#34816a");
    expect(result.matched["accent"]).toBe("--color-evergreen-500");
  });

  it("defaults accent when multiple scale families make the pick ambiguous", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"),
      v("--color-blue-300", "#93c5fd"), v("--color-blue-500", "#3b82f6"), v("--color-blue-700", "#1d4ed8"),
      v("--color-rose-300", "#fda4af"), v("--color-rose-500", "#f43f5e"), v("--color-rose-700", "#be123c"),
    ]);
    expect(result.defaulted).toContain("accent");
  });

  it("does not treat neutral or status scales as an accent family", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"),
      v("--color-gray-300", "#d1d5db"), v("--color-gray-500", "#6b7280"), v("--color-gray-700", "#374151"),
    ]);
    expect(result.defaulted).toContain("accent");
  });

  it("still prefers literal accent names over a scale family", () => {
    const result = mapVarsToBrand([
      v("--color-bg", "#FFFFFF"), v("--color-accent", "#FF0000"),
      v("--color-teal-300", "#5eead4"), v("--color-teal-500", "#14b8a6"), v("--color-teal-700", "#0f766e"),
    ]);
    expect(result.brand?.accent).toBe("#FF0000");
  });

  it("flags a dark variant when dark-scoped vars exist", () => {
    const result = mapVarsToBrand([v("--color-bg", "#FFFFFF"), v("--color-bg", "#000000", true)]);
    expect(result.hasDarkVariant).toBe(true);
    expect(result.brand?.mode).toBe("light");
  });
});
