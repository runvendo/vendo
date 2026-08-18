// @vitest-environment jsdom
/**
 * DataTable, with the rows painted by the model.
 *
 * A whole row written by hand, where a `cell` function per column would be three
 * functions saying the same thing. The math AND the formatting run where the
 * record is in scope, so these tests are about the two things that has to
 * survive: the cells must land under the headers they belong to, and everything
 * the table already does — sorting, search, the fold — must keep running on
 * `rows` and still address the right painted row.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";
import { TableRow } from "../../src/kit/data/table-row.js";
import { Text } from "../../src/kit/values.js";
import { Button } from "../../src/kit/forms/button.js";

/** Cents, as a host's API really hands them over. */
const accounts = [
  { id: "a1", name: "Checking", balance_cents: 128_450 },
  { id: "a2", name: "Savings", balance_cents: 900_125 },
  { id: "a3", name: "Travel", balance_cents: 4_200 },
];

/** The one-line helper a screen defines at the top of its own file: the ÷100 and
 *  the currency both live here, where the row is written. */
const money = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const COLUMNS = [
  { key: "name", label: "Account" },
  { key: "balance_cents", label: "Balance", align: "end" as const },
  { label: "", align: "end" as const },
];

const painted = (props: Partial<React.ComponentProps<typeof DataTable>> = {}, onCancel = (_id: string) => {}) => (
  <DataTable rows={accounts} columns={COLUMNS} {...props}>
    {accounts.map((a) => (
      <TableRow key={a.id}>
        <Text text={a.name} />
        <Text text={money(a.balance_cents)} />
        <Button label="Cancel" onClick={() => onCancel(a.id)} />
      </TableRow>
    ))}
  </DataTable>
);

/** Each body row as `[cell, cell, …]` — the read that would catch a cell landing
 *  in the wrong column, which is the whole risk of handing the row over. */
const grid = (): string[][] =>
  screen.getAllByRole("row").slice(1).map((row) =>
    within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""));

/** jsdom lays nothing out, so a table can never overflow in a test. State the
 *  measurement the component reads; it still does its own folding. */
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
    const proto = HTMLElement.prototype as Partial<Record<"offsetWidth" | "clientWidth", number>>;
    delete proto.offsetWidth;
    delete proto.clientWidth;
  };
}

describe("DataTable with model-painted rows", () => {
  it("puts each row's children in the columns, in order, with the row's own math done", () => {
    render(painted());
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Account", "Balance", ""]);
    // Dollars, not cents: the ÷100 ran where the row was written.
    expect(grid()).toEqual([
      ["Checking", "$1,284.50", "Cancel"],
      ["Savings", "$9,001.25", "Cancel"],
      ["Travel", "$42.00", "Cancel"],
    ]);
    expect(screen.queryByText("$128,450.00")).toBeNull();
  });

  it("takes each cell's alignment from its column", () => {
    render(painted());
    const first = screen.getAllByRole("row")[1]!;
    expect(within(first).getAllByRole("cell").map((cell) => cell.style.textAlign))
      .toEqual(["left", "right", "right"]);
  });

  // THE `row.index` CLAIM. Sorting reorders the row model; a painted row is
  // addressed by its index into the ROOT data array, which sorting does not
  // touch. Picking by the row model's own position instead would leave every
  // cell one row off the record its header sorted it by.
  it("reorders the painted rows when the table sorts", () => {
    render(painted({ sortBy: "balance_cents desc" }));
    expect(grid().map((row) => row[0])).toEqual(["Savings", "Checking", "Travel"]);
    expect(grid().map((row) => row[1])).toEqual(["$9,001.25", "$1,284.50", "$42.00"]);

    // …and on a header press, the other way, still cell-for-record.
    fireEvent.click(screen.getByRole("columnheader", { name: /Balance/u }));
    expect(grid()).toEqual([
      ["Travel", "$42.00", "Cancel"],
      ["Checking", "$1,284.50", "Cancel"],
      ["Savings", "$9,001.25", "Cancel"],
    ]);
  });

  it("filters the painted rows on the search box, which still reads `rows`", () => {
    render(painted({ searchable: true }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sav" } });
    expect(grid()).toEqual([["Savings", "$9,001.25", "Cancel"]]);
  });

  it("fires the pressed row's own handler", () => {
    const pressed: string[] = [];
    render(painted({ sortBy: "balance_cents desc" }, (id) => pressed.push(id)));
    // The FIRST row on screen after sorting is Savings — press its button.
    fireEvent.click(within(screen.getAllByRole("row")[1]!).getByRole("button", { name: "Cancel" }));
    expect(pressed).toEqual(["a2"]);
  });

  it("lets children win over a column's cell slot", () => {
    render(
      <DataTable
        rows={accounts}
        columns={[{ key: "name", label: "Account", cell: <Text text="from the slot" /> }]}
      >
        {accounts.map((a) => <TableRow key={a.id}><Text text={a.name} /></TableRow>)}
      </DataTable>,
    );
    expect(screen.queryByText("from the slot")).toBeNull();
    expect(grid()).toEqual([["Checking"], ["Savings"], ["Travel"]]);
  });

  // A keyless column is what an action column is: giving it a fake key makes
  // its header click-to-sort and puts "Cancel" in the global search, so a
  // person typing "can" would be shown every row.
  it("neither sorts nor searches a column with no key", () => {
    render(painted({ searchable: true }));
    const action = screen.getAllByRole("columnheader")[2]!;
    expect(action.style.cursor).toBe("default");
    fireEvent.click(action);
    expect(grid().map((row) => row[0])).toEqual(["Checking", "Savings", "Travel"]);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cancel" } });
    expect(screen.getByText("No data")).toBeTruthy();
  });

  // The fold is written against five judge failures, and DataTable cannot reach
  // into a model-built row to do it — so the row folds its own, off the same
  // set and the same column labels. It is opt-in now, because folding is what
  // made rows three lines tall.
  it("folds the columns that do not fit into the row's first cell", () => {
    const restore = stubLayout(200, 420);
    try {
      render(painted({ fold: true }));
      expect(screen.getAllByRole("columnheader")).toHaveLength(2);
      const first = screen.getAllByRole("row")[1]!;
      const cells = within(first).getAllByRole("cell");
      expect(cells).toHaveLength(2);
      // The action column has no label, so its folded line is the control
      // alone — "Checking: Cancel" would read as the row's own value.
      expect(cells[0]!.textContent).toBe("CheckingCancel");
      expect(cells[1]!.textContent).toBe("$1,284.50");
    } finally {
      restore();
    }
  });

  // Unasked, nothing gives way at all — the frame scrolls — so a painted row
  // still paints every cell it was written with, on the narrowest surface there
  // is. A row that loses its own control is a row that lost the reason it was
  // painted by hand.
  it("paints every cell on a frame too narrow for them, unasked", () => {
    const restore = stubLayout(200, 420);
    try {
      render(painted());
      const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
      expect(cells).toHaveLength(3);
      expect(cells.map((cell) => cell.textContent)).toEqual(["Checking", "$1,284.50", "Cancel"]);
      expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(3);
    } finally {
      restore();
    }
  });

  /**
   * THE INDEX CLAIM, on the columns this time. The column that gives way is the
   * least important one WHEREVER it sits, so the ones left are not a prefix: a row
   * that placed its cells by counting them would put the balance under the action
   * column's header, which is the misalignment this whole component exists to
   * prevent.
   */
  it("keeps every cell under its own column when a middle column gives way", () => {
    const restore = stubLayout(200, 420);
    try {
      render(painted({ columns: [COLUMNS[0]!, { ...COLUMNS[1]!, priority: 0 }, COLUMNS[2]!] }));
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toEqual(["Account", ""]);
      // Two cells: the account, and the control the third column was written for.
      expect(grid()).toEqual([
        ["Checking", "Cancel"],
        ["Savings", "Cancel"],
        ["Travel", "Cancel"],
      ]);
      expect(screen.queryByText("$1,284.50")).toBeNull();
    } finally {
      restore();
    }
  });

  // A row is only valid inside a table, and nothing refuses one written
  // outside: showing none of its cells would be a blank where content was.
  it("still shows its cells when it is written outside a DataTable", () => {
    render(<table><tbody><tr><TableRow><Text text="orphan" /><Text text="row" /></TableRow></tr></tbody></table>);
    expect(within(screen.getByRole("row")).getAllByRole("cell").map((c) => c.textContent))
      .toEqual(["orphan", "row"]);
  });

  // A painted row paints one cell per DATA column, so the trailing actions cell
  // is the TABLE's to append. Dropping it left every body row one cell short of
  // its own header — the column misalignment this whole feature exists to
  // prevent — with no action control anywhere on the table.
  it("appends the actions cell to a painted row, against that row", () => {
    const pressed: string[] = [];
    render(painted({
      sortBy: "balance_cents desc",
      // One element per record, in `rows` order — the shape a `(row) => elements`
      // slot arrives in. Sorted, the list's order is nobody's screen order, so
      // the trailing cell has to find its row by identity like every other cell.
      rowActions: accounts.map((a) => (
        <>
          <Text text={a.name} />
          <Button label="Pay" onClick={() => pressed.push(a.id)} />
        </>
      )),
    }));
    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    for (const row of grid()) expect(row).toHaveLength(headers.length);
    expect(grid().map((row) => row[3])).toEqual(["SavingsPay", "CheckingPay", "TravelPay"]);

    fireEvent.click(within(screen.getAllByRole("row")[1]!).getByRole("button", { name: "Pay" }));
    expect(pressed).toEqual(["a2"]);
  });

  it("still renders the field-binding table when it is handed no children", () => {
    render(<DataTable rows={accounts} columns={[{ key: "name", label: "Account" }, { key: "balance_cents", label: "Cents" }]} />);
    expect(grid()).toEqual([["Checking", "128450"], ["Savings", "900125"], ["Travel", "4200"]]);
  });
});
