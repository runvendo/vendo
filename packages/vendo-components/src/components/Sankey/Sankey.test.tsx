import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider";
import { brandToChartPalette } from "../../theme/brand-to-chart-palette";
import { sankeyDescriptor } from "./descriptor";
import { Sankey } from "./impl";

const moneyFlow = {
  title: "Monthly Cash Flow",
  nodes: [
    { id: "income", label: "Income" },
    { id: "rent", label: "Rent" },
    { id: "food", label: "Food" },
    { id: "subscriptions", label: "Subscriptions" },
    { id: "savings", label: "Savings" },
  ],
  links: [
    { source: "income", target: "rent", value: 2200 },
    { source: "income", target: "food", value: 680 },
    { source: "income", target: "subscriptions", value: 120 },
    { source: "income", target: "savings", value: 1000 },
  ],
};

const maple = {
  version: 1 as const,
  accent: "#1B1C22",
  background: "#F4F3F0",
  surface: "#FFFFFF",
  text: "#14151A",
  mutedText: "#8A8B92",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  radius: "16px",
  mode: "light" as const,
};

describe("Sankey", () => {
  it("schema accepts a valid money-flow graph", () => {
    expect(sankeyDescriptor.propsSchema.safeParse(moneyFlow).success).toBe(true);
  });

  it("schema rejects duplicate node ids, missing node references, and non-positive links", () => {
    expect(
      sankeyDescriptor.propsSchema.safeParse({
        nodes: [
          { id: "income", label: "Income" },
          { id: "income", label: "Income duplicate" },
        ],
        links: [{ source: "income", target: "missing", value: 10 }],
      }).success,
    ).toBe(false);

    expect(
      sankeyDescriptor.propsSchema.safeParse({
        nodes: [
          { id: "income", label: "Income" },
          { id: "rent", label: "Rent" },
        ],
        links: [{ source: "income", target: "rent", value: 0 }],
      }).success,
    ).toBe(false);
  });

  it("renders a titled, accessible SVG with one node bar and one curved band per datum", () => {
    const { container } = render(
      <VendoThemeProvider brand={maple}>
        <Sankey {...moneyFlow} />
      </VendoThemeProvider>,
    );

    expect(screen.getByRole("heading", { name: "Monthly Cash Flow" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /sankey flow diagram/i })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-sankey-node]").length).toBe(moneyFlow.nodes.length);
    expect(container.querySelectorAll("[data-sankey-link]").length).toBe(moneyFlow.links.length);
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("2,200")).toBeInTheDocument();
  });

  it("uses the brand-derived chart palette from the theme", () => {
    const { container } = render(
      <VendoThemeProvider brand={maple}>
        <Sankey {...moneyFlow} />
      </VendoThemeProvider>,
    );

    const firstNode = container.querySelector("[data-sankey-node] rect");
    expect(firstNode?.getAttribute("fill")?.toLowerCase()).toBe(brandToChartPalette(maple)[0].toLowerCase());
  });

  it("computes the same layout across renders for the same graph", () => {
    const { container, rerender } = render(
      <VendoThemeProvider brand={maple}>
        <Sankey {...moneyFlow} />
      </VendoThemeProvider>,
    );
    const firstPath = container.querySelector("[data-sankey-link]")?.getAttribute("d");

    rerender(
      <VendoThemeProvider brand={maple}>
        <Sankey {...moneyFlow} />
      </VendoThemeProvider>,
    );

    expect(container.querySelector("[data-sankey-link]")?.getAttribute("d")).toBe(firstPath);
  });
});
