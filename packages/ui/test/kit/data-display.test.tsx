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
});
