import { describe, it, expect } from "vitest";
import { defaultBrand } from "./brand";
import { brandToCssVars } from "./brand-to-css-vars";

describe("brandToCssVars", () => {
  it("maps 1:1 brand fields onto their --flowlet-* vars", () => {
    const vars = brandToCssVars(defaultBrand);
    expect(vars["--flowlet-accent"]).toBe(defaultBrand.accent);
    expect(vars["--flowlet-bg"]).toBe(defaultBrand.background);
    expect(vars["--flowlet-surface"]).toBe(defaultBrand.surface);
    expect(vars["--flowlet-fg"]).toBe(defaultBrand.text);
    expect(vars["--flowlet-fg-muted"]).toBe(defaultBrand.mutedText);
    expect(vars["--flowlet-font"]).toBe(defaultBrand.fontFamily);
  });

  it("normalizes a numeric radius to a px string", () => {
    const vars = brandToCssVars(defaultBrand);
    expect(vars["--flowlet-radius"]).toBe("8px");
  });

  it("passes through a px-string radius unchanged", () => {
    const vars = brandToCssVars({ ...defaultBrand, radius: "12px" });
    expect(vars["--flowlet-radius"]).toBe("12px");
  });

  it("normalizes a zero radius to 0px", () => {
    const vars = brandToCssVars({ ...defaultBrand, radius: 0 });
    expect(vars["--flowlet-radius"]).toBe("0px");
  });

  it("produces non-empty derived vars for border, shadow, and skeleton", () => {
    const vars = brandToCssVars(defaultBrand);
    expect(vars["--flowlet-border"]).toBeTruthy();
    expect(vars["--flowlet-shadow"]).toBeTruthy();
    expect(vars["--flowlet-skeleton"]).toBeTruthy();
  });

  it("is deterministic: calling twice with the same brand yields deep-equal output", () => {
    const first = brandToCssVars(defaultBrand);
    const second = brandToCssVars(defaultBrand);
    expect(first).toEqual(second);
  });
});
