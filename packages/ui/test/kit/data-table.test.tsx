// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";
import { EnumBadge } from "../../src/kit/values.js";

// Money in the rows is DOLLARS: a `format:"money"` column pretty-prints the
// value as it stands, so a host's cents field is divided by 100 upstream.
// The dates are built off the CURRENT year because that is what decides whether
// a date cell shows its year — a hardcoded year would flip every expectation
// here the moment the calendar turned.
const year = new Date().getFullYear();
const rows = [
  { id: 1, client: { name: "Hartwell" }, amount: 2500, dueDate: `${year}-03-14`, status: "overdue" },
  { id: 2, client: { name: "Acme" }, amount: 900, dueDate: `${year}-01-02`, status: "paid" },
  { id: 3, client: { name: "Borealis" }, amount: 1750, dueDate: `${year}-02-20`, status: "overdue" },
];

/**
 * jsdom lays nothing out, so a table can never overflow in a test. State the
 * measurement the component reads — the component still does its own measuring,
 * folding and header hiding.
 */
function stubLayout(columnWidth: number, clientWidth: number): () => void {
  const observers = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  for (const [prop, value] of [["offsetWidth", columnWidth], ["clientWidth", clientWidth]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  return () => {
    globalThis.ResizeObserver = observers;
    // `delete` needs a writable view — both props are readonly on HTMLElement.
    const proto = HTMLElement.prototype as Partial<Record<"offsetWidth" | "clientWidth", number>>;
    delete proto.offsetWidth;
    delete proto.clientWidth;
  };
}

const columns = [
  { key: "client.name", label: "Client" },
  { key: "amount", label: "Amount", format: "money" as const, align: "end" as const },
  { key: "dueDate", label: "Due", format: "date" as const },
];

describe("DataTable", () => {
  it("renders rows, resolves dot-path keys, and formats cells", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Mar 14")).toBeTruthy();
  });

  it("applies an initial sortBy", () => {
    render(<DataTable rows={rows} columns={columns} sortBy="amount asc" />);
    const bodyRows = screen.getAllByRole("row").slice(1); // drop header
    const firstCells = bodyRows.map((r) => within(r).getAllByRole("cell")[0]?.textContent);
    expect(firstCells[0]).toBe("Acme"); // 900 is smallest
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
    render(<DataTable rows={[{ id: 9, client: { name: "X" }, amount: Number.NaN }]} columns={columns} />);
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
  // formatted — "$2,500.00", "Mar 14" — while the filters read the raw field
  // ("2500", "2026-03-14"), so a person searching for what is in front of them
  // got the empty state, and one searching the raw form got rows whose text
  // does not contain what they typed.
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
    expect(within(filter).getByRole("option", { name: "Mar 14" })).toBeTruthy();
    expect(within(filter).queryByRole("option", { name: `${year}-03-14` })).toBeNull();

    fireEvent.change(filter, { target: { value: "Mar 14" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  // The year is the same four characters on every row of a this-year column, so
  // it is clutter — until the column straddles years, when dropping it would
  // make two different days read as the same one.
  it("drops the year from a date column that is entirely this year", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getByText("Mar 14")).toBeTruthy();
    expect(screen.queryByText(`Mar 14, ${year}`)).toBeNull();
  });

  it("keeps the year for the WHOLE column once its rows straddle years", () => {
    const straddling = [
      { id: 1, client: { name: "Hartwell" }, amount: 2500, dueDate: `${year}-03-14` },
      { id: 2, client: { name: "Acme" }, amount: 900, dueDate: `${year - 1}-12-30` },
    ];
    render(<DataTable rows={straddling} columns={columns} />);
    expect(screen.getByText(`Mar 14, ${year}`)).toBeTruthy();
    expect(screen.getByText(`Dec 30, ${year - 1}`)).toBeTruthy();
    expect(screen.queryByText("Mar 14")).toBeNull();
  });

  it("never breaks a formatted figure across two lines", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getByText("$2,500.00").closest("td")!.style.whiteSpace).toBe("nowrap");
    expect(screen.getByText("Hartwell").closest("td")!.style.whiteSpace).toBe("");
  });

  it("re-declares the spacing scale on its own element for density=compact", () => {
    const { container } = render(<DataTable rows={rows} columns={columns} density="compact" />);
    const root = container.querySelector<HTMLElement>('[data-kit="DataTable"]')!;
    expect(root.style.getPropertyValue("--vendo-density-table-padding")).toBe("7px 10px");
  });

  // A narrow surface used to scroll the right-hand columns out of view with
  // nothing to say they existed. Only the ones that do not FIT fold — a table
  // that folded every column but the first is a stack of cards, which is not a
  // table and reads as one field per line.
  it("keeps the columns that fit and folds only the rest into the first cell", () => {
    // Three 200px columns; 420px of room, so two fit and the third folds.
    const restore = stubLayout(200, 420);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toHaveLength(2);
      expect(headers[0]).toContain("Client");
      expect(headers[1]).toContain("Amount");
      expect(headers.join()).not.toContain("Due");

      const firstRow = screen.getAllByRole("row")[1]!;
      expect(within(firstRow).getAllByRole("cell")).toHaveLength(2);
      // The folded column rides in the FIRST cell, labelled, not in every cell.
      const cells = within(firstRow).getAllByRole("cell");
      expect(cells[0]!.textContent).toContain("Due: Mar 14");
      expect(cells[1]!.textContent).not.toContain("Due:");
    } finally {
      restore();
    }
  });

  it("keeps the first column however narrow the surface is", () => {
    const restore = stubLayout(200, 40);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(1);
      const firstRow = screen.getAllByRole("row")[1]!;
      expect(firstRow.textContent).toContain("Amount: $2,500.00");
      expect(firstRow.textContent).toContain("Due: Mar 14");
    } finally {
      restore();
    }
  });

  // Folding a column must not undo the slot that column carries: rendering the
  // formatted text instead folded a status pill back into the bare word
  // "overdue" — the precise thing the slots exist to kill.
  it("a folded column keeps its cell slot", () => {
    const restore = stubLayout(200, 420);
    try {
      render(
        <DataTable
          rows={rows}
          columns={[
            ...columns,
            { key: "status", label: "Status", cell: <EnumBadge field="status" tones={{ overdue: "danger" }} /> },
          ]}
        />,
      );
      const firstRow = screen.getAllByRole("row")[1]!;
      expect(firstRow.textContent).toContain("Status: ");
      const badge = within(firstRow).getByText("Overdue");
      expect(badge.getAttribute("data-kit")).toBe("EnumBadge");
      expect(badge.getAttribute("data-tone")).toBe("danger");
      expect(firstRow.textContent).not.toContain("Status: overdue");
    } finally {
      restore();
    }
  });

  // The fold-out rides INSIDE the first cell, and that cell is often a figure —
  // nowrap and tabular-nums, both inherited. An unbreakable folded line scrolls
  // the table sideways, which is the failure folding exists to prevent.
  it("wraps its folded lines even when the first column is a figure", () => {
    const restore = stubLayout(200, 220);
    try {
      render(<DataTable rows={rows} columns={[columns[1]!, columns[0]!, columns[2]!]} />);
      const cell = screen.getByText("$2,500.00").closest("td")!;
      expect(cell.style.whiteSpace).toBe("nowrap");
      const fold = cell.querySelector("div")!;
      expect(fold.textContent).toContain("Client: Hartwell");
      expect(fold.style.whiteSpace).toBe("normal");
      expect(fold.style.fontVariantNumeric).toBe("normal");
    } finally {
      restore();
    }
  });

  it("folds nothing when every column fits", () => {
    const restore = stubLayout(100, 900);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(3);
      expect(screen.getAllByRole("row")[1]!.textContent).not.toContain("Due:");
    } finally {
      restore();
    }
  });

  it("leaves the table wide where nothing can be measured (SSR, jsdom)", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });
});
