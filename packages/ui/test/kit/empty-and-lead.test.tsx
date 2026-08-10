// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DonutChart } from "../../src/kit/charts/donut.js";
import { CardList } from "../../src/kit/data/card-list.js";
import { DataTable } from "../../src/kit/data/data-table.js";
import { Stat } from "../../src/kit/data/stat.js";
import { Card } from "../../src/kit/layout.js";
import { Text } from "../../src/kit/values.js";

const columns = [
  { key: "category", label: "Category" },
  { key: "amount", label: "Amount", format: "money" as const, align: "end" as const },
];

describe("nothing here is a rendered state, not an absence", () => {
  it("a table handed no rows states it in words and draws no header row", () => {
    const { container } = render(
      <DataTable rows={[]} columns={columns} searchable filterableBy={["category"]} />,
    );
    expect(screen.getByText("Nothing to show yet")).toBeTruthy();
    // A table of headers reads as data still loading, and a search box has
    // nothing to search: neither is on the page.
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("a filter that matches nothing keeps the table, because the control is the way out", () => {
    const { container } = render(
      <DataTable rows={[{ category: "coffee", amount: 6130 }]} columns={columns} searchable />,
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(container.querySelector("table")).not.toBeNull();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("a card list and a chart handed nothing say so in one content-sized box", () => {
    const list = render(<CardList items={[]} titleField="name" />);
    expect(screen.getByText("Nothing to show yet")).toBeTruthy();
    list.unmount();

    const { container } = render(
      <DonutChart data={[]} categoryKey="category" valueKey="amount" emptyState="No spending yet" />,
    );
    const box = container.querySelector<HTMLElement>('[data-kit="EmptyNote"]');
    expect(box).not.toBeNull();
    expect(screen.getByText("No spending yet")).toBeTruthy();
    // Nothing was plotted, so no chart-height room is held open — a 220px box
    // around one line is the blank area the style rules call out.
    expect(box!.style.height).toBe("");
    expect(box!.style.minHeight).toBe("");
  });
});

describe("a zero metric states the zero in words and keeps the figure", () => {
  it("money", () => {
    render(<Stat label="Total spent" value={0} format="money" />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy(); // the exact figure is still on screen
  });

  it("a count", () => {
    render(<Stat label="Pending transfers" value={0} />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("leaves a non-zero value and worded prose alone", () => {
    render(<Stat label="Total spent" value={424311} format="money" />);
    expect(screen.getByText("$4,243.11")).toBeTruthy();
    expect(screen.queryByText("Nothing yet")).toBeNull();
  });
});

/** The text scale off the rendered style attribute — read from the markup React
 *  emits rather than through jsdom's CSS parser, which does not evaluate calc. */
const scale = (markup: string): number =>
  Number(/font-size:calc\(var\(--vendo-font-size[^)]*\) \* ([\d.]+)\)/.exec(markup)?.[1] ?? 1);

describe("one thing leads", () => {
  it("the screen's headline outsizes the metric figure it summarises", () => {
    const headline = scale(renderToStaticMarkup(<Text text="This month's spending" variant="heading" />));
    const figure = scale(renderToStaticMarkup(<Stat label="Total spent" value={424311} format="money" />));
    expect(headline).toBeGreaterThan(figure);
  });

  it("a heading inside a card is that section's title, not a second headline", () => {
    const outer = scale(renderToStaticMarkup(<Text text="Screen headline" variant="heading" />));
    const inner = scale(
      renderToStaticMarkup(
        <Card>
          <Text text="Section" variant="heading" />
        </Card>,
      ).split("<h3")[1] ?? "",
    );
    expect(inner).toBeLessThan(outer);
    expect(inner).toBeGreaterThan(1); // still a heading, just not the headline
  });
});
