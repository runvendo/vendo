// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";

const rows = [
  { id: 1, client: { name: "Hartwell" }, amountCents: 250000, dueDate: "2026-03-14", status: "overdue" },
  { id: 2, client: { name: "Acme" }, amountCents: 90000, dueDate: "2026-01-02", status: "paid" },
  { id: 3, client: { name: "Borealis" }, amountCents: 175000, dueDate: "2026-02-20", status: "overdue" },
];

const columns = [
  { key: "client.name", label: "Client" },
  { key: "amountCents", label: "Amount", format: "money" as const, align: "end" as const },
  { key: "dueDate", label: "Due", format: "date" as const },
];

describe("DataTable", () => {
  it("renders rows, resolves dot-path keys, and formats cells", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Mar 14, 2026")).toBeTruthy();
  });

  it("applies an initial sortBy", () => {
    render(<DataTable rows={rows} columns={columns} sortBy="amountCents asc" />);
    const bodyRows = screen.getAllByRole("row").slice(1); // drop header
    const firstCells = bodyRows.map((r) => within(r).getAllByRole("cell")[0]?.textContent);
    expect(firstCells[0]).toBe("Acme"); // 90000 is smallest
  });

  it("caps rows with limit", () => {
    render(<DataTable rows={rows} columns={columns} limit={2} />);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
  });

  it("filters via the search box when searchable", () => {
    render(<DataTable rows={rows} columns={columns} searchable />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "borealis" } });
    expect(screen.getByText("Borealis")).toBeTruthy();
    expect(screen.queryByText("Hartwell")).toBeNull();
  });

  it("shows the named-query empty state for zero rows", () => {
    render(<DataTable rows={[]} columns={columns} emptyState="No overdue invoices" />);
    expect(screen.getByText("No overdue invoices")).toBeTruthy();
  });

  it("renders an unrenderable numeric cell as a placeholder, never $NaN", () => {
    render(<DataTable rows={[{ id: 9, client: { name: "X" }, amountCents: Number.NaN }]} columns={columns} />);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  // Generation names a column that was never declared often enough to matter:
  // an unresolvable id reaches TanStack's getColumn, which console.errors on
  // every render and applies nothing.
  it("ignores a sortBy naming an undeclared column, without console noise", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<DataTable rows={rows} columns={columns} sortBy="timestamp desc" />);
      const bodyRows = screen.getAllByRole("row").slice(1);
      const firstCells = bodyRows.map((r) => within(r).getAllByRole("cell")[0]?.textContent);
      expect(firstCells).toEqual(["Hartwell", "Acme", "Borealis"]); // untouched row order
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("still applies a sortBy naming a dot-path column", () => {
    render(<DataTable rows={rows} columns={columns} sortBy="client.name asc" />);
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(within(bodyRows[0]!).getAllByRole("cell")[0]?.textContent).toBe("Acme");
  });

  it("drops a filterableBy key naming an undeclared column rather than ship a dead control", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<DataTable rows={rows} columns={columns} filterableBy={["status", "dueDate"]} />);
      expect(screen.queryByLabelText("Filter by Status")).toBeNull();
      expect(screen.getByLabelText("Filter by Due")).toBeTruthy();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
