// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../../src/kit/data/badge.js";
import { CardList } from "../../src/kit/data/card-list.js";
import { Stat } from "../../src/kit/data/stat.js";

describe("Stat", () => {
  it("formats a money value from cents and shows a trend", () => {
    render(<Stat label="Total overdue" value={250000} format="money" trend="+12% MoM" />);
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Total overdue")).toBeTruthy();
    expect(screen.getByText("+12% MoM")).toBeTruthy();
  });

  it("renders a placeholder for an unrenderable value, never $NaN", () => {
    render(<Stat label="Broken" value={Number.NaN} format="money" />);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("renders an empty value as a compact em dash with a tooltip, never a bare tile", () => {
    render(<Stat label="Bank" value="" />);
    const dash = screen.getByText("—");
    expect(dash.getAttribute("title")).toBe("No data yet");
    expect(dash.hasAttribute("data-empty")).toBe(true);
  });

  it("caps prose-length values with the full text in the tooltip (a KPI tile is not a paragraph)", () => {
    const prose = "No host tool exposes session metrics, so this can't be shown.";
    render(<Stat label="Sessions" value={prose} />);
    expect(screen.queryByText(prose)).toBeNull();
    const capped = screen.getByText(/…$/);
    expect(capped.textContent!.length).toBeLessThanOrEqual(40);
    expect(capped.getAttribute("title")).toBe(prose);
  });

  it("leaves a short text value untouched — no tooltip, no truncation", () => {
    render(<Stat label="Plan" value="Growth (annual)" />);
    const value = screen.getByText("Growth (annual)");
    expect(value.getAttribute("title")).toBeNull();
  });
});

describe("Badge", () => {
  it("renders its label with a tone", () => {
    render(<Badge label="Active" tone="success" />);
    const badge = screen.getByText("Active");
    expect(badge.getAttribute("data-tone")).toBe("success");
  });
});

describe("CardList", () => {
  const items = [
    { id: 1, name: "Hartwell", balanceCents: 250000, status: "overdue" },
    { id: 2, name: "Acme", balanceCents: 90000, status: "paid" },
  ];

  it("renders one card per item with formatted fields", () => {
    render(
      <CardList
        items={items}
        titleField="name"
        fields={[{ key: "balanceCents", label: "Balance", format: "money" }]}
      />,
    );
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getAllByText("Balance")).toHaveLength(2); // one per card
  });

  it("shows an empty state when there are no items", () => {
    render(<CardList items={[]} titleField="name" emptyState="No clients" />);
    expect(screen.getByText("No clients")).toBeTruthy();
  });

  it("renders an em dash for an empty field value, never a bare label", () => {
    render(
      <CardList
        items={[{ id: 1, name: "Hartwell", bank: "" }]}
        titleField="name"
        fields={[{ key: "bank", label: "Bank" }]}
      />,
    );
    expect(screen.getByText("Bank")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });
});
