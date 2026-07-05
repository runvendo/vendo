import { describe, it, expect } from "vitest";
import { themeToStyle } from "./theme";

describe("themeToStyle", () => {
  it("returns an empty object for no theme", () => {
    expect(themeToStyle()).toEqual({});
  });

  it("maps provided tokens to --vendo-* custom properties", () => {
    const style = themeToStyle({ accent: "#f00", radius: "20px" }) as Record<string, string>;
    expect(style["--vendo-accent"]).toBe("#f00");
    expect(style["--vendo-radius"]).toBe("20px");
    expect(style["--vendo-bg"]).toBeUndefined();
  });

  it("sets colorScheme when scheme is given", () => {
    const style = themeToStyle({ scheme: "dark" }) as Record<string, string>;
    expect(style.colorScheme).toBe("dark");
  });
});
