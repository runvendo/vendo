// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/kit/format.js";
import { RowContext } from "../../src/kit/row.js";
import { DateTime, EnumBadge, Money, Num, Percent, Text } from "../../src/kit/values.js";

describe("Money", () => {
  it("formats a dollar amount as currency", () => {
    render(<Money amount={1234.56} />);
    expect(screen.getByText("$1,234.56")).toBeTruthy();
  });

  it("renders a placeholder for NaN — never $NaN", () => {
    const { container } = render(<Money amount={Number.NaN} />);
    expect(container.textContent).toBe("—");
    expect(container.textContent).not.toContain("NaN");
  });
});

describe("DateTime", () => {
  it("formats a date-only string without slipping a day", () => {
    render(<DateTime value="2026-03-14" mode="date" />);
    expect(screen.getByText("Mar 14, 2026")).toBeTruthy();
  });

  it("renders a placeholder for an unparseable value", () => {
    const { container } = render(<DateTime value="nope" />);
    expect(container.textContent).toBe("—");
  });

  it("compact drops the YEAR and keeps the clock", () => {
    expect(formatDateTime("2026-08-12", { mode: "date" })).toBe("Aug 12, 2026");
    expect(formatDateTime("2026-08-12", { mode: "date", compact: true })).toBe("Aug 12");
    const stamp = formatDateTime(Date.UTC(2026, 7, 12, 15, 30), {
      mode: "datetime",
      compact: true,
      timeZone: "UTC",
    });
    expect(stamp).toContain("Aug 12");
    expect(stamp).toMatch(/3:30/);
    expect(stamp).not.toContain("2026");
    const { container } = render(<DateTime value="2026-08-12" mode="date" compact />);
    expect(container.textContent).toBe("Aug 12");
  });
});

describe("Percent + Num", () => {
  it("formats a ratio as a percentage", () => {
    render(<Percent value={0.42} />);
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("groups a large number", () => {
    render(<Num value={1234567} />);
    expect(screen.getByText("1,234,567")).toBeTruthy();
  });
});

describe("EnumBadge", () => {
  it("humanizes a snake_case enum value", () => {
    render(<EnumBadge value="past_due" />);
    expect(screen.getByText("Past due")).toBeTruthy();
  });

  it("honors an explicit label + tone map", () => {
    render(<EnumBadge value="overdue" labels={{ overdue: "OVERDUE" }} tones={{ overdue: "danger" }} />);
    const badge = screen.getByText("OVERDUE");
    expect(badge.getAttribute("data-tone")).toBe("danger");
  });

  it("renders nothing for an empty value", () => {
    const { container } = render(<EnumBadge value={null} />);
    expect(container.textContent).toBe("");
  });

  // `labels`/`tones` are model-authored records, so an enum value that happens to
  // name an Object.prototype member must read as ABSENT — a bare index hands
  // React `Object.prototype.toString`, a function, as the pill's label.
  it("an enum value that names a prototype member reads as data, never a method", () => {
    const { container } = render(<EnumBadge value="toString" labels={{}} tones={{}} />);
    expect(container.textContent).toBe("To string");
    expect(screen.getByText("To string").getAttribute("data-tone")).toBe("neutral");
  });
});

describe("Text", () => {
  it("renders a heading element for the heading variant", () => {
    render(<Text text="Overview" variant="heading" />);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
});

describe("the cell slot — a value bound to the row it is standing in", () => {
  const inRow = (row: Record<string, unknown>, node: ReactNode) =>
    render(<RowContext.Provider value={row}>{node}</RowContext.Provider>);

  it("takes its primary value from the row's field, not its own prop", () => {
    expect(inRow({ amount: 12.5 }, <Money amount={0} field="amount" />).container.textContent).toBe("$12.50");
    expect(inRow({ due: "2026-03-14" }, <DateTime value="" field="due" mode="date" />).container.textContent).toBe(
      "Mar 14, 2026",
    );
    expect(inRow({ share: 0.42 }, <Percent value={0} field="share" />).container.textContent).toBe("42%");
    expect(inRow({ n: 1234567 }, <Num value={0} field="n" />).container.textContent).toBe("1,234,567");
    expect(inRow({ status: "past_due" }, <EnumBadge value={null} field="status" />).container.textContent).toBe(
      "Past due",
    );
    expect(inRow({ client: { name: "Maple" } }, <Text text="" field="client.name" />).container.textContent).toBe(
      "Maple",
    );
  });

  it("falls back to the explicit prop outside a row — the same component reads the same either way", () => {
    expect(render(<Money amount={7} field="amount" />).container.textContent).toBe("$7.00");
    expect(render(<Text text="Maple" field="client.name" />).container.textContent).toBe("Maple");
  });

  // `active`, `isPaid`, `archived` — a boolean is one of the commonest fields
  // there is, and React renders one as literally nothing.
  it("shows a boolean field instead of swallowing it", () => {
    expect(inRow({ active: false }, <Text field="active" />).container.textContent).toBe("false");
    expect(inRow({ active: true }, <Text field="active" />).container.textContent).toBe("true");
  });

  it("a field holding the wrong type lands on the placeholder, never a crash", () => {
    // Money needs a number and Text needs a node; a column bound to the wrong
    // field must not take the screen down with it.
    expect(inRow({ amount: "lots" }, <Money amount={1} field="amount" />).container.textContent).toBe("—");
    expect(inRow({ client: { name: "Maple" } }, <Text text="" field="client" />).container.textContent).toBe("—");
    expect(inRow({ status: "  " }, <EnumBadge value="paid" field="status" />).container.textContent).toBe("");
  });
});
