import { describe, expect, it } from "vitest";
import { brandToFluidTheme } from "./brand-to-fluid-theme";

describe("brandToFluidTheme", () => {
  it("maps FlowletTheme tokens 1:1 onto FluidTheme names", () => {
    const fluid = brandToFluidTheme({
      accent: "#2D6A4F",
      surface: "#FFFFFF",
      fg: "#14151A",
      fgMuted: "#8A8B92",
      bg: "#F4F3F0",
      font: "Inter, sans-serif",
      radius: "16px",
      scheme: "light",
    });
    expect(fluid).toEqual({
      accent: "#2D6A4F",
      surface: "#FFFFFF",
      text: "#14151A",
      mutedText: "#8A8B92",
      background: "#F4F3F0",
      fontFamily: "Inter, sans-serif",
      radius: 16,
      mode: "light",
    });
  });

  it("only maps what the brand sets — absent tokens stay absent (fluidkit's only-set-tokens rule)", () => {
    expect(brandToFluidTheme({ accent: "#000" })).toEqual({ accent: "#000" });
    expect(brandToFluidTheme({})).toEqual({});
    expect(brandToFluidTheme(undefined)).toEqual({});
  });

  it("parses px radius, drops unparseable radius, and ignores scheme auto", () => {
    expect(brandToFluidTheme({ radius: "8px" }).radius).toBe(8);
    expect(brandToFluidTheme({ radius: "0.5rem" }).radius).toBeUndefined();
    expect(brandToFluidTheme({ scheme: "auto" }).mode).toBeUndefined();
    expect(brandToFluidTheme({ scheme: "dark" }).mode).toBe("dark");
  });

  it("merges the host's liquid knobs on top", () => {
    const fluid = brandToFluidTheme({ accent: "#000" }, { material: "flat", intensity: "present" });
    expect(fluid.material).toBe("flat");
    expect(fluid.intensity).toBe("present");
    // knobs absent = not set (glass/whisper is fluidkit's own character, not ours to force)
    expect(brandToFluidTheme({ accent: "#000" }).material).toBeUndefined();
  });
});
