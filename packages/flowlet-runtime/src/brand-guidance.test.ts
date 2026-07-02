import { describe, it, expect } from "vitest";
import { buildBrandGuidance } from "./brand-guidance";

const tokens = {
  "--flowlet-accent": "#1B1C22",
  "--flowlet-bg": "#F4F3F0",
  "--flowlet-surface": "#FFFFFF",
  "--flowlet-fg": "#14151A",
  "--flowlet-fg-muted": "#8A8B92",
  "--flowlet-font": "Inter, ui-sans-serif, system-ui, sans-serif",
  "--flowlet-radius": "16px",
  "--flowlet-border": "color-mix(in srgb, #14151A 12%, #FFFFFF)",
};

describe("buildBrandGuidance", () => {
  it("renders a data-driven section from the token map — every var name and value appears", () => {
    const s = buildBrandGuidance({ tokens });
    expect(s).toContain("--flowlet-accent");
    expect(s).toContain("#1B1C22");
    expect(s).toContain("--flowlet-radius");
    expect(s).toContain("16px");
  });

  it("instructs var() usage over hardcoded palettes and bans the generic-AI look", () => {
    const s = buildBrandGuidance({ tokens });
    expect(s).toMatch(/var\(--flowlet-accent\)/);
    expect(s.toLowerCase()).toContain("do not hardcode");
    expect(s.toLowerCase()).toContain("gradient");
  });

  it("includes host norms verbatim when provided, omits the norms block when absent", () => {
    const norms = {
      density: "calm and generous — one idea per card",
      tone: "quiet financial confidence, no exclamation marks",
    };
    const withNorms = buildBrandGuidance({ tokens, norms });
    expect(withNorms).toContain(norms.density);
    expect(withNorms).toContain(norms.tone);
    const without = buildBrandGuidance({ tokens });
    expect(without.toLowerCase()).not.toContain("density");
  });

  it("contains no host-specific words — it is a pure function of its inputs", () => {
    const s = buildBrandGuidance({ tokens });
    expect(s).not.toMatch(/maple|bank|accounting/i);
  });
});
