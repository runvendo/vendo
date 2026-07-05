import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { brandTokensSchema, defaultBrand } from "./brand";
import { mapBrandToTheme } from "./map-brand-to-theme";
import { VendoThemeProvider } from "./VendoThemeProvider";

describe("BrandTokens", () => {
  it("defaultBrand is valid and versioned", () => {
    expect(brandTokensSchema.safeParse(defaultBrand).success).toBe(true);
    expect(defaultBrand.version).toBe(1);
  });

  it("rejects a non-literal color reference", () => {
    expect(brandTokensSchema.safeParse({ ...defaultBrand, accent: "var(--x)" }).success).toBe(false);
  });

  it("accepts a numeric radius (legacy default)", () => {
    expect(brandTokensSchema.safeParse({ ...defaultBrand, radius: 8 }).success).toBe(true);
  });

  it("accepts a px-string radius", () => {
    expect(brandTokensSchema.safeParse({ ...defaultBrand, radius: "8px" }).success).toBe(true);
    expect(brandTokensSchema.safeParse({ ...defaultBrand, radius: "12.5px" }).success).toBe(true);
  });

  it("rejects an invalid radius value", () => {
    expect(brandTokensSchema.safeParse({ ...defaultBrand, radius: "8em" }).success).toBe(false);
    expect(brandTokensSchema.safeParse({ ...defaultBrand, radius: -1 }).success).toBe(false);
  });

  it("maps accent/background/text onto OpenUI theme fields", () => {
    const theme = mapBrandToTheme({ ...defaultBrand, accent: "#0A7CFF", background: "#FFFFFF", text: "#111111" });
    expect(theme.interactiveAccentDefault).toBe("#0A7CFF");
    expect(theme.background).toBe("#FFFFFF");
    expect(theme.textNeutralPrimary).toBe("#111111");
  });

  it("normalizes numeric radius to px string in theme", () => {
    const theme = mapBrandToTheme({ ...defaultBrand, radius: 8 });
    expect(theme.radiusM).toBe("8px");
  });

  it("passes through px-string radius unchanged", () => {
    const theme = mapBrandToTheme({ ...defaultBrand, radius: "12px" });
    expect(theme.radiusM).toBe("12px");
  });
});

describe("VendoThemeProvider", () => {
  it("renders children", () => {
    render(
      <VendoThemeProvider brand={defaultBrand}>
        <span data-testid="child">x</span>
      </VendoThemeProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
