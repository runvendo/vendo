import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { brandTokensSchema, defaultBrand } from "./brand";
import { mapBrandToTheme } from "./map-brand-to-theme";
import { FlowletThemeProvider } from "./FlowletThemeProvider";

describe("BrandTokens", () => {
  it("defaultBrand is valid and versioned", () => {
    expect(brandTokensSchema.safeParse(defaultBrand).success).toBe(true);
    expect(defaultBrand.version).toBe(1);
  });

  it("rejects a non-literal color reference", () => {
    expect(brandTokensSchema.safeParse({ ...defaultBrand, accent: "var(--x)" }).success).toBe(false);
  });

  it("maps accent/background/text onto OpenUI theme fields", () => {
    const theme = mapBrandToTheme({ ...defaultBrand, accent: "#0A7CFF", background: "#FFFFFF", text: "#111111" });
    expect(theme.interactiveAccentDefault).toBe("#0A7CFF");
    expect(theme.background).toBe("#FFFFFF");
    expect(theme.textNeutralPrimary).toBe("#111111");
  });
});

describe("FlowletThemeProvider", () => {
  it("renders children", () => {
    render(
      <FlowletThemeProvider brand={defaultBrand}>
        <span data-testid="child">x</span>
      </FlowletThemeProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
