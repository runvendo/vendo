import { describe, expect, it } from "vitest";
import { defaultVendoTheme } from "../src/theme.js";
import { readThemeCssVariables } from "../src/tree/mcp-shim/theme.js";

function style(values: Record<string, string>): Pick<CSSStyleDeclaration, "getPropertyValue"> {
  return { getPropertyValue: (name) => values[name] ?? "" };
}

describe("MCP Apps shim theme reconstruction", () => {
  it("reconstructs a complete VendoTheme from the injected --vendo-* variables", () => {
    const theme = readThemeCssVariables(style({
      "--vendo-color-background": " #FBFBFA ",
      "--vendo-color-surface": "#FFFFFF",
      "--vendo-color-text": "#111111",
      "--vendo-color-muted": "#908C85",
      "--vendo-color-accent": "#111111",
      "--vendo-color-accent-text": "#FFFFFF",
      "--vendo-color-danger": "#B42318",
      "--vendo-color-border": "#E2E1DE",
      "--vendo-font-family": "Maple Sans, system-ui, sans-serif",
      "--vendo-heading-family": "Maple Display, serif",
      "--vendo-font-size": "15px",
      "--vendo-radius-small": "6px",
      "--vendo-radius-medium": "14px",
      "--vendo-radius-large": "14px",
      "--vendo-density": "compact",
      "--vendo-motion": "reduced",
    }));

    expect(theme).toEqual({
      colors: {
        background: "#FBFBFA",
        surface: "#FFFFFF",
        text: "#111111",
        muted: "#908C85",
        accent: "#111111",
        accentText: "#FFFFFF",
        danger: "#B42318",
        border: "#E2E1DE",
      },
      typography: {
        fontFamily: "Maple Sans, system-ui, sans-serif",
        headingFamily: "Maple Display, serif",
        baseSize: "15px",
      },
      radius: { small: "6px", medium: "14px", large: "14px" },
      density: "compact",
      motion: "reduced",
    });
  });

  it("uses neutral defaults for missing variables and invalid enum tokens", () => {
    expect(readThemeCssVariables(style({
      "--vendo-density": "cramped",
      "--vendo-motion": "fast",
    }))).toEqual(defaultVendoTheme);
  });
});
