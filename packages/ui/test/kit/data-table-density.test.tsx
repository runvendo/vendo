// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";

const payee = "Pacific Northwest Sustainable Grain and Milling Cooperative Association";

const rows = [{ id: 1, to: payee, amount: 128400, date: "2026-08-01", status: "pending" }];

const columns = [
  { key: "to", label: "To" },
  { key: "amount", label: "Amount", format: "money" as const, align: "end" as const },
  { key: "date", label: "Date", format: "date" as const },
];

describe("DataTable density", () => {
  it("never breaks a formatted value across lines", () => {
    render(<DataTable rows={rows} columns={columns} />);
    const [, amount, date] = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    expect(amount!.style.whiteSpace).toBe("nowrap");
    expect(date!.style.whiteSpace).toBe("nowrap");
  });

  it("clamps a long text cell to one line and keeps the full value on title", () => {
    render(<DataTable rows={rows} columns={columns} />);
    const cell = screen.getByText(payee);
    expect(cell.tagName).toBe("DIV");
    expect(cell.getAttribute("title")).toBe(payee);
    // A text column stays wrappable so the table cannot force a horizontal
    // scroll; the single line comes from the clamp, not from nowrap.
    expect(cell.closest("td")!.style.whiteSpace).toBe("");
  });
});
