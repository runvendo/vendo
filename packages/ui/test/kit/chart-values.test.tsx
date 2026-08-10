// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarChart } from "../../src/kit/charts/bar.js";
import { DonutChart } from "../../src/kit/charts/donut.js";

/**
 * A bar or a slice shows a proportion, not a number: before this, the only
 * numbers a chart-only screen carried were recharts' axis ticks inside the SVG,
 * so "each category's amount matches the tool's number" was unanswerable from
 * the document. Each category chart now prints its own values as DOM text.
 */
const rows = [
  { category: "housing", amount: 285000 },
  { category: "coffee", amount: 6130 },
];

/** The values as the document carries them — SVG axis ticks are not innerText,
 *  and this is the text a screen is graded on. */
const listed = (container: HTMLElement): string =>
  container.querySelector('[data-kit="ChartValues"]')?.textContent ?? "";

describe("a category chart carries its own exact values", () => {
  it("BarChart lists each category with its formatted value", () => {
    const { container } = render(<BarChart data={rows} xKey="category" series={["amount"]} format="money" />);
    expect(listed(container)).toContain("housing$2,850.00");
    expect(listed(container)).toContain("coffee$61.30");
  });

  it("DonutChart lists each slice with its formatted value", () => {
    const { container } = render(<DonutChart data={rows} categoryKey="category" valueKey="amount" format="money" />);
    expect(listed(container)).toContain("housing$2,850.00");
    expect(listed(container)).toContain("coffee$61.30");
  });

  it("a multi-series bar chart lists nothing — the values belong to no single category", () => {
    const { container } = render(
      <BarChart data={[{ month: "Jan", spend: 100, income: 200 }]} xKey="month" series={["spend", "income"]} />,
    );
    expect(container.querySelector('[data-kit="ChartValues"]')).toBeNull();
  });

  it("an invalid value is dropped from the list, never rendered as NaN", () => {
    const { container } = render(
      <BarChart
        data={[{ category: "housing", amount: 285000 }, { category: "broken", amount: Number.NaN }]}
        xKey="category"
        series={["amount"]}
        format="money"
      />,
    );
    expect(listed(container)).toContain("$2,850.00");
    expect(listed(container)).not.toContain("NaN");
    expect(listed(container)).not.toContain("broken");
  });
});
