// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../../src/kit/data/badge.js";
import { Calendar, type CalendarProps } from "../../src/kit/data/calendar.js";
import { CardList } from "../../src/kit/data/card-list.js";
import { Stat } from "../../src/kit/data/stat.js";
import { Text } from "../../src/kit/values.js";

/** The one-line helper a screen defines at the top of its own file, now that the
 *  formatting is the screen's own job. */
const money = (dollars: number): string =>
  dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });

describe("Stat", () => {
  it("shows the figure it was handed, and a trend beside it", () => {
    render(<Stat label="Total overdue" value={money(2500)} trend="+12% MoM" />);
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Total overdue")).toBeTruthy();
    expect(screen.getByText("+12% MoM")).toBeTruthy();
  });

  it("writes a unit after the figure, so a latency is never a bare number", () => {
    render(<Stat label="Tail latency" value={842} unit="ms" />);
    expect(screen.getByText("842 ms")).toBeTruthy();
  });

  it("renders a placeholder for an absent value, never the word 'undefined'", () => {
    render(<Stat label="Bank" value={undefined as never} />);
    const dash = screen.getByText("—");
    expect(dash.hasAttribute("data-empty")).toBe(true);
    expect(screen.queryByText(/undefined/)).toBeNull();
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

  /** THE FAILURE the tokens were deleted for: the VM bridges Intl, so a screen
   *  writes the idiom it was trained on — `total.toLocaleString("en-US")` — and a
   *  tile that ALSO named its token turned that text into the em dash reserved
   *  for missing data, because a token read NUMBERS. There is no token left; the
   *  figure arrives finished, whatever kind of figure it is. */
  it("renders a value that was formatted upstream exactly as given", () => {
    render(
      <>
        <Stat label="Total" value={(57_000).toLocaleString("en-US")} />
        <Stat label="Renews" value="Mar 14, 2026" />
      </>,
    );
    expect(screen.getByText("57,000")).toBeTruthy();
    expect(screen.getByText("Mar 14, 2026")).toBeTruthy();
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
    render(<Stat label="Balance" value={money(1113.1)} />);
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

  it("renders one card per item, each field a label/value row", () => {
    // What a screen does now: the figure is formatted where the items are
    // PREPARED, and the card prints the finished text.
    render(
      <CardList
        items={items.map((item) => ({ ...item, balance: money(item.balance) }))}
        titleField="name"
        fields={[{ key: "balance", label: "Balance" }]}
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

  /** A field written as the bare KEY — the same shorthand a column takes. */
  it("takes a field written as its bare key", () => {
    render(<CardList items={items} titleField="name" fields={["balance"]} />);
    expect(screen.getAllByText("balance")).toHaveLength(2);
    expect(screen.getByText("2500")).toBeTruthy();
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

  /** No `fields` is "show me the record", the same default a table's columns
   *  have. The title and the badge are already ON the card, so a bare list is
   *  everything else and never the title printed twice. */
  it("shows the item's own fields when it is given none, less the two already on the card", () => {
    render(<CardList items={[{ name: "Hartwell", balance: 2500, status: "overdue" }]} titleField="name" badgeField="status" />);
    expect(screen.getByText("balance")).toBeTruthy();
    expect(screen.getByText("2500")).toBeTruthy();
    expect(screen.getAllByText("Hartwell")).toHaveLength(1);
    expect(screen.queryByText("status")).toBeNull();
  });

  /** A field's `cell` written as a function of the item: the VM called it once
   *  per item, in `items` order, and the cards paint in that same order — so the
   *  match is positional, unlike a DataTable's, which sorts. */
  it("renders a field's cell slot once per item, against that item", () => {
    render(
      <CardList
        items={items}
        titleField="name"
        fields={[{
          key: "balance",
          label: "Balance",
          // The ÷100 and the currency both ran where the item was in scope —
          // what the retired field-name binding had nowhere to put.
          cell: items.map((item) => <Text text={money(item.balance / 100)} />),
        }]}
      />,
    );
    expect(screen.getAllByText("Balance")).toHaveLength(2);
    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(screen.getByText("$9.00")).toBeTruthy();
  });
});

describe("Calendar", () => {
  // The maple bills the benchmark asks to see as a calendar. Aug 2026 opens on a
  // Saturday, so its first row leads with six of July's days.
  // The figures arrive FORMATTED, as they do everywhere else in the Kit — the
  // screen writes the currency where it prepares its items.
  const bills = [
    { id: "bill_1", name: "Mission St Rent", amount: "$2,850.00", due_date: "2026-08-01", status: "paid" },
    { id: "bill_3", name: "Ridgeline Gym", amount: "$45.00", due_date: "2026-08-09", status: "missed" },
    { id: "bill_4", name: "Verdant Streaming", amount: "$15.99", due_date: "2026-08-12", status: "upcoming" },
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

  it("lands each item on its own day, with its name, figure and status", () => {
    const container = month();
    expect(cell(container, "2026-08-01").textContent).toBe("1Mission St Rent$2,850.00Paid");
    expect(cell(container, "2026-08-09").textContent).toBe("9Ridgeline Gym$45.00Missed");
    expect(cell(container, "2026-08-12").textContent).toBe("12Verdant Streaming$15.99Upcoming");
    // A day nothing falls on carries its number and nothing else.
    expect(cell(container, "2026-08-02").textContent).toBe("2");
  });

  it("shows the amount field AS GIVEN, never dressed as money", () => {
    // The last limb of the dead value tier: the field was formatted as currency
    // whatever it held, so a shift roster's HOURS rendered "$520.00" — a figure
    // in a unit no tool ever returned.
    const container = month({
      items: [{ id: "shift_1", name: "Kitchen shift", amount: 520, due_date: "2026-08-03", status: "scheduled" }],
      month: "2026-08",
    });
    expect(cell(container, "2026-08-03").textContent).toBe("3Kitchen shift520Scheduled");
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
