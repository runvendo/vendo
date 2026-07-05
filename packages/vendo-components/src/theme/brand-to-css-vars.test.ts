import { describe, it, expect } from "vitest";
import { defaultBrand } from "./brand";
import { brandToCssVars } from "./brand-to-css-vars";

describe("brandToCssVars", () => {
  it("maps 1:1 brand fields onto their --vendo-* vars", () => {
    const vars = brandToCssVars(defaultBrand);
    expect(vars["--vendo-accent"]).toBe(defaultBrand.accent);
    expect(vars["--vendo-bg"]).toBe(defaultBrand.background);
    expect(vars["--vendo-surface"]).toBe(defaultBrand.surface);
    expect(vars["--vendo-fg"]).toBe(defaultBrand.text);
    expect(vars["--vendo-fg-muted"]).toBe(defaultBrand.mutedText);
    expect(vars["--vendo-font"]).toBe(defaultBrand.fontFamily);
  });

  it("normalizes a numeric radius to a px string", () => {
    const vars = brandToCssVars(defaultBrand);
    expect(vars["--vendo-radius"]).toBe("8px");
  });

  it("passes through a px-string radius unchanged", () => {
    const vars = brandToCssVars({ ...defaultBrand, radius: "12px" });
    expect(vars["--vendo-radius"]).toBe("12px");
  });

  it("normalizes a zero radius to 0px", () => {
    const vars = brandToCssVars({ ...defaultBrand, radius: 0 });
    expect(vars["--vendo-radius"]).toBe("0px");
  });

  it("produces non-empty derived vars for border, shadow, and skeleton", () => {
    const vars = brandToCssVars(defaultBrand);
    expect(vars["--vendo-border"]).toBeTruthy();
    expect(vars["--vendo-shadow"]).toBeTruthy();
    expect(vars["--vendo-skeleton"]).toBeTruthy();
  });

  it("is deterministic: calling twice with the same brand yields deep-equal output", () => {
    const first = brandToCssVars(defaultBrand);
    const second = brandToCssVars(defaultBrand);
    expect(first).toEqual(second);
  });
});
