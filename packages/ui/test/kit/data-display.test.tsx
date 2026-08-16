// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../../src/kit/data/badge.js";
import { Calendar, type CalendarProps } from "../../src/kit/data/calendar.js";
import { CardList } from "../../src/kit/data/card-list.js";
import { Stat } from "../../src/kit/data/stat.js";

describe("Stat", () => {
  it("formats a dollar value as money and shows a trend", () => {
    render(<Stat label="Total overdue" value={2500} format="money" trend="+12% MoM" />);
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Total overdue")).toBeTruthy();
    expect(screen.getByText("+12% MoM")).toBeTruthy();
  });

  it("reads seconds as a duration, and writes a unit after the figure", () => {
    render(
      <>
        <Stat label="Build time" value={268} format="duration" />
        <Stat label="Tail latency" value={842} unit="ms" format="number" />
      </>,
    );
    expect(screen.getByText("4m 28s")).toBeTruthy();
    expect(screen.getByText("842 ms")).toBeTruthy();
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

  it("speaks the shared tone vocabulary, and 'default' still means neutral", () => {
    const { container } = render(
      <>
        <Stat label="Plain" value={1} />
        <Stat label="Old" value={1} tone="default" />
        <Stat label="New" value={1} tone="success" />
      </>,
    );
    const tiles = [...container.querySelectorAll<HTMLElement>('[data-kit="Stat"]')];
    expect(tiles.map((tile) => tile.dataset.tone)).toEqual(["neutral", "neutral", "success"]);
    // Neutral is exactly today's look; a real tone is not.
    const color = (tile: HTMLElement) => tile.querySelector("strong")!.style.color;
    expect(color(tiles[1]!)).toBe(color(tiles[0]!));
    expect(color(tiles[2]!)).not.toBe(color(tiles[0]!));
  });

  // A money figure has no break opportunity of its own, so a tile narrower than
  // its number cut it off mid-number ("$1,113.1").
  it("lets a value too wide for its tile break rather than clip", () => {
    render(<Stat label="Balance" value={1113.1} format="money" />);
    expect(screen.getByText("$1,113.10").style.overflowWrap).toBe("anywhere");
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
    { id: 1, name: "Hartwell", balance: 2500, status: "overdue" },
    { id: 2, name: "Acme", balance: 900, status: "paid" },
  ];

  it("renders one card per item with formatted fields", () => {
    render(
      <CardList
        items={items}
        titleField="name"
        fields={[{ key: "balance", label: "Balance", format: "money" }]}
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

describe("Calendar", () => {
  // The maple bills the benchmark asks to see as a calendar. Aug 2026 opens on a
  // Saturday, so its first row leads with six of July's days.
  const bills = [
    { id: "bill_1", name: "Mission St Rent", amount: 2850, due_date: "2026-08-01", status: "paid" },
    { id: "bill_3", name: "Ridgeline Gym", amount: 45, due_date: "2026-08-09", status: "missed" },
    { id: "bill_4", name: "Verdant Streaming", amount: 15.99, due_date: "2026-08-12", status: "upcoming" },
  ];
  const month = (props: Partial<CalendarProps> = {}): HTMLElement =>
    render(
      <Calendar
        items={bills}
        dateField="due_date"
        titleField="name"
        amountField="amount"
        statusField="status"
        tones={{ paid: "success", missed: "danger" }}
        {...props}
      />,
    ).container;
  const cell = (container: HTMLElement, day: string): Element =>
    container.querySelector(`[data-day="${day}"]`)!;

  it("lands each item on its own day, with its name, amount and status", () => {
    const container = month();
    expect(cell(container, "2026-08-01").textContent).toBe("1Mission St Rent$2,850.00Paid");
    expect(cell(container, "2026-08-09").textContent).toBe("9Ridgeline Gym$45.00Missed");
    expect(cell(container, "2026-08-12").textContent).toBe("12Verdant Streaming$15.99Upcoming");
    // A day nothing falls on carries its number and nothing else.
    expect(cell(container, "2026-08-02").textContent).toBe("2");
  });

  it("takes its month from the earliest item, and `month` over that", () => {
    expect(month().querySelector("caption")!.textContent).toBe("August 2026");
    expect(month({ month: "2026-09" }).querySelector("caption")!.textContent).toBe("September 2026");
  });

  it("falls back to the items when `month` names no real month, never to the clock", () => {
    // The silent substitution: a malformed month resolved to the machine's own
    // month, so the grid on screen was one the items are not in and nothing said
    // so. Dated in the PAST, which the clock can never be — with the Aug 2026
    // bills this test passed on the bug, because that IS the month it is.
    const past = [{ id: "a", name: "Rent", amount: 1200, due_date: "2019-04-11", status: "paid" }];
    for (const bad of ["banana", "2019-13", ""]) {
      expect(month({ items: past, month: bad }).querySelector("caption")!.textContent, bad).toBe("April 2019");
    }
  });

  it("ignores a date that names no real day when choosing the month", () => {
    // "2026-02-30" is the one Date.parse does not refuse: it rolls forward to
    // March 2. Left unchecked it won the inference away from August, and the
    // item still landed on no day at all.
    const container = month({ items: [{ id: "x", name: "Ghost", due_date: "2026-02-30" }, ...bills] });
    expect(container.querySelector("caption")!.textContent).toBe("August 2026");
    expect(container.textContent).not.toContain("Ghost");
  });

  it("mutes the days the neighbouring months own", () => {
    const container = month();
    const number = (day: string): string => cell(container, day).querySelector("div")!.getAttribute("style")!;
    expect(number("2026-07-26")).toContain("var(--vendo-color-muted");
    expect(number("2026-08-01")).toContain("var(--vendo-color-text");
  });

  it("tones an item by its status, and leaves an unmapped one neutral", () => {
    const container = month();
    const chip = (day: string): string => cell(container, day).querySelectorAll("div")[1]!.getAttribute("style")!;
    expect(chip("2026-08-01")).toContain("var(--vendo-color-success");
    expect(chip("2026-08-09")).toContain("var(--vendo-color-danger");
    expect(chip("2026-08-12")).not.toContain("var(--vendo-color-danger");
  });

  it("fails soft on missing data, still drawing the month it was asked for", () => {
    const container = month({ items: undefined as never, month: "2026-08" });
    expect(container.querySelector("caption")!.textContent).toBe("August 2026");
    expect(cell(container, "2026-08-01").textContent).toBe("1");
  });
});
