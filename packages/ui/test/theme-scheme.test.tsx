// @vitest-environment jsdom
// ENG-226 — dark scheme derived from theme background luminance. No new
// contract token: themeCssVariables emits --vendo-color-scheme from the WCAG
// relative luminance of colors.background, and the chrome sheet's
// `color-scheme: var(--vendo-color-scheme, light)` flips every existing
// light-dark() branch alive on dark-brand hosts.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { colorSchemeForBackground, defaultVendoTheme, themeCssVariables } from "../src/theme.js";
import { VendoProvider, createVendoClient } from "../src/index.js";
import { ChromeRoot } from "../src/chrome/chrome-root.js";
import { CHROME_CSS } from "../src/chrome/chrome-css.js";

describe("colorSchemeForBackground", () => {
  it("derives light from light backgrounds", () => {
    expect(colorSchemeForBackground("#ffffff")).toBe("light");
    expect(colorSchemeForBackground("#f3ede2")).toBe("light"); // Maple cream
    // Mid gray (relative luminance ≈ .22) sits above the .179 flip point.
    expect(colorSchemeForBackground("#808080")).toBe("light");
  });

  it("derives dark from dark backgrounds", () => {
    expect(colorSchemeForBackground("#000000")).toBe("dark");
    expect(colorSchemeForBackground("#16181e")).toBe("dark");
    expect(colorSchemeForBackground("#123")).toBe("dark"); // #rgb shorthand
    expect(colorSchemeForBackground("#16181eff")).toBe("dark"); // alpha ignored
    expect(colorSchemeForBackground("  #16181E  ")).toBe("dark"); // trim + case
  });

  it("falls back to light when the color is unparseable", () => {
    expect(colorSchemeForBackground("rgb(20, 20, 24)")).toBe("light");
    expect(colorSchemeForBackground("oklch(20% 0.02 260)")).toBe("light");
    expect(colorSchemeForBackground("not-a-color")).toBe("light");
    expect(colorSchemeForBackground("")).toBe("light");
    expect(colorSchemeForBackground("#12345")).toBe("light"); // invalid length
  });
});

describe("themeCssVariables color scheme", () => {
  it("emits --vendo-color-scheme derived from colors.background", () => {
    expect(themeCssVariables(defaultVendoTheme)["--vendo-color-scheme"]).toBe("light");
    const dark = { ...defaultVendoTheme, colors: { ...defaultVendoTheme.colors, background: "#101216" } };
    expect(themeCssVariables(dark)["--vendo-color-scheme"]).toBe("dark");
  });
});

describe("ChromeRoot scheme wiring", () => {
  const darkColors = {
    ...defaultVendoTheme.colors,
    background: "#101216",
    surface: "#181b21",
    text: "#f2f2f5",
    muted: "#9a9ba6",
    border: "#2b2e37",
  };

  it("sets --vendo-color-scheme: dark on .vendo-root for a dark theme", () => {
    const client = createVendoClient({ baseUrl: "http://vendo.test/api/vendo" });
    const { container } = render(
      <VendoProvider client={client} theme={{ colors: darkColors }}>
        <ChromeRoot automaticPolicyNotice={false}>content</ChromeRoot>
      </VendoProvider>,
    );
    const root = container.querySelector<HTMLElement>(".vendo-root");
    expect(root).not.toBeNull();
    expect(root!.style.getPropertyValue("--vendo-color-scheme")).toBe("dark");
  });

  it("keeps light on .vendo-root for the default theme", () => {
    const client = createVendoClient({ baseUrl: "http://vendo.test/api/vendo" });
    const { container } = render(
      <VendoProvider client={client}>
        <ChromeRoot automaticPolicyNotice={false}>content</ChromeRoot>
      </VendoProvider>,
    );
    const root = container.querySelector<HTMLElement>(".vendo-root");
    expect(root!.style.getPropertyValue("--vendo-color-scheme")).toBe("light");
  });

  it("the sheet reads the derived scheme instead of pinning light", () => {
    expect(CHROME_CSS).toContain("color-scheme: var(--vendo-color-scheme, light)");
    expect(CHROME_CSS).not.toContain("color-scheme: light;");
  });
});
