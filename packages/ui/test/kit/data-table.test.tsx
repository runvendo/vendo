// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  // A dropdown is a list of the values that EXIST, so picking one means "this
  // value" — never "any value containing this one". Substring matching there is
  // invisible until two of the real values overlap, and then the table quietly
  // shows rows the person excluded: filtering to Paid listed the unpaid ones.
  it("a filter dropdown matches the value picked, not every value containing it", () => {
    const invoices = [
      { id: 1, client: { name: "Hartwell" }, status: "paid" },
      { id: 2, client: { name: "Acme" }, status: "unpaid" },
    ];
    render(
      <DataTable
        rows={invoices}
        columns={[{ key: "client.name", label: "Client" }, { key: "status", label: "Status" }]}
        filterableBy={["status"]}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by Status" }), { target: { value: "paid" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  // Every filter compares against the text the cell SHOWS. The columns are
  // formatted — "$2,500.00", "Mar 14, 2026" — while the filters read the raw
  // field ("250000", "2026-03-14"), so a person searching for what is in front
  // of them got the empty state, and one searching the raw form got rows whose
  // text does not contain what they typed.
  it("searches the text the cells actually show", () => {
    render(<DataTable rows={rows} columns={columns} searchable />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Mar 14" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();

    fireEvent.change(search, { target: { value: "$2,500" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Borealis")).toBeNull();
  });

  it("offers filter options in the words the column displays", () => {
    render(<DataTable rows={rows} columns={columns} filterableBy={["dueDate"]} />);
    const filter = screen.getByRole("combobox", { name: "Filter by Due" });
    expect(within(filter).getByRole("option", { name: "Mar 14, 2026" })).toBeTruthy();
    expect(within(filter).queryByRole("option", { name: "2026-03-14" })).toBeNull();

    fireEvent.change(filter, { target: { value: "Mar 14, 2026" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });
});
