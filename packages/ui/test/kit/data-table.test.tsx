// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("reads a duration column as a duration, and still sorts it as the number it is", () => {
    const builds = [
      { id: 1, name: "4192", duration_seconds: 133 },
      { id: 2, name: "4187", duration_seconds: 46 },
    ];
    render(
      <DataTable
        rows={builds}
        columns={[{ key: "name" }, { key: "duration_seconds", label: "Took", format: "duration" }]}
        sortBy="duration_seconds asc"
      />,
    );
    expect(screen.getByText("2m 13s")).toBeTruthy();
    // The cell TEXT is formatted; the data stays numeric, so the shortest run
    // leads rather than "133" sorting before "46" as a string would.
    const first = screen.getAllByRole("row")[1]!;
    expect(within(first).getAllByRole("cell")[0]?.textContent).toBe("4187");
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

  /**
   * What a browser really measures: a laid-out width is FRACTIONAL, and
   * `offsetWidth`/`clientWidth` are that width rounded to a whole pixel. The
   * scroller carries a 1px border on each side, so its rect is two pixels wider
   * than the room inside it.
   */
  function stubSubpixelLayout(widths: Record<string, number>, room: number, border = 1): () => void {
    const observers = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    const rects = HTMLElement.prototype.getBoundingClientRect;
    const styles = globalThis.getComputedStyle;
    const widthOf = (el: HTMLElement) =>
      el.tagName === "TH" ? widths[el.textContent?.replace(/[▲▼]/gu, "").trim() ?? ""] ?? 0 : room;
    for (const prop of ["offsetWidth", "clientWidth"] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) { return Math.round(widthOf(this)); },
      });
    }
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return { width: widthOf(this) + (this.tagName === "TH" ? 0 : border * 2) } as DOMRect;
    };
    globalThis.getComputedStyle = ((el: Element) =>
      el.tagName === "DIV"
        ? { borderLeftWidth: `${border}px`, borderRightWidth: `${border}px` }
        : styles(el)) as typeof globalThis.getComputedStyle;
    return () => {
      globalThis.ResizeObserver = observers;
      globalThis.getComputedStyle = styles;
      HTMLElement.prototype.getBoundingClientRect = rects;
      Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    };
  }

  /**
   * THE REGRESSION: a column that FITS must not fold. Three columns filling a
   * 1000px table measure 320.8125 + 387.546875 + 291.640625 — exactly 1000 — but
   * every `offsetWidth` rounds up, and summing them says 321 + 388 + 292 = 1001.
   * One pixel of rounding per column, and the last column silently stops being a
   * column. Chrome's own numbers, off a 1000px-wide viewport.
   */
  it("keeps a column whose fractional widths fill the room exactly", () => {
    const restore = stubSubpixelLayout({ Client: 320.8125, Amount: 387.546875, Due: 291.640625 }, 1_000);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(3);
      expect(screen.getAllByRole("row")[1]!.textContent).not.toContain("Due:");
    } finally {
      restore();
    }
  });

  /**
   * The other rounded reading is the room itself: a scroller laid out on a
   * fraction reports a `clientWidth` rounded DOWN from what it has, and the
   * column filling that fraction folds. Chrome's numbers off a 1025px viewport,
   * where the table sits in a container of fractional width.
   */
  it("keeps a column that fits the room's own fraction", () => {
    const restore = stubSubpixelLayout({ Client: 328.625, Amount: 397, Due: 298.765625 }, 1_024.390_625);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    } finally {
      restore();
    }
  });

  /**
   * …and the room is the CONTENT box, so a themed border width that is itself
   * fractional (`borderWidth` is a host's own string) belongs to neither side of
   * the comparison. Reading the fraction off the scroller's border box instead
   * hands the table its border back as room, and a column overflowing by a hair
   * stays put — the fold's own failure, mirrored.
   */
  it("does not spend a fractional border as room", () => {
    const restore = stubSubpixelLayout({ Client: 100, Amount: 100, Due: 100.093_75 }, 300, 0.093_75);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(2);
      expect(screen.getAllByRole("row")[1]!.textContent).toContain("Due:");
    } finally {
      restore();
    }
  });

  /**
   * Every header keeps its OWN width wherever it sits, which is what the
   * uniform `stubLayout` cannot express: the bug below turns on the actions
   * header being narrower than the data column whose slot it takes over once
   * the row folds. The observer's callback is handed back so a test can drive a
   * SECOND measurement — the resize that a static render never reaches.
   */
  function stubMeasuredLayout(widths: Record<string, number>, initialWidth: number) {
    const observers = globalThis.ResizeObserver;
    let resize = () => {};
    let clientWidth = initialWidth;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        // A column header by its label, the actions header by the name it
        // carries for the screen reader — never by POSITION, which is the
        // thing folding changes.
        const key = this.getAttribute("aria-label") ?? this.textContent?.replace(/[▲▼]/gu, "").trim() ?? "";
        return widths[key] ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => clientWidth });
    return {
      /** A resize the surface really had. */
      resizeTo: (next: number) => { clientWidth = next; act(() => resize()); },
      /** A callback the observer fires with nothing about the surface changed —
       *  a reflow, a scrollbar, a parent settling. */
      settle: () => act(() => resize()),
      restore: () => {
        globalThis.ResizeObserver = observers;
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
        Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
      },
    };
  }

  /**
   * THE REGRESSION: a folded column must not come BACK on the next resize.
   *
   * The natural edges are recorded once, while every column is still shown —
   * every later decision is taken against them. The guard on that recording
   * counted headers with `>=`, which a FOLDED row satisfies by coincidence:
   * three data columns plus actions fold to `[Client, Amount, Actions]`, which
   * is three children for three columns. The next callback then recorded the
   * 40px ACTIONS header as the third data column's natural width, the third
   * edge fell from 600 to 340, and at 350px of room the column that had just
   * folded away reappeared.
   *
   * Only a resize reaches it — the first measurement is correct — so it is a
   * table that breaks as the person narrows the window, and nothing static
   * catches it.
   */
  const WIDTHS = { Client: 100, Amount: 200, Due: 300, Actions: 40 };
  const headerText = () => screen.getAllByRole("columnheader").map((h) => h.textContent).join();

  it("keeps a folded column folded when the actions column is measured again", () => {
    const { settle, restore } = stubMeasuredLayout(WIDTHS, 350);
    try {
      render(<DataTable rows={rows} columns={columns} rowActions={<span>Pay</span>} />);
      // Natural edges are 100 / 300 / 600, so at 350px of room the third column
      // folds and the actions column rides beside the two that fit.
      expect(screen.getAllByRole("columnheader")).toHaveLength(3);
      expect(headerText()).not.toContain("Due");

      settle();

      // Nothing about the surface changed, so nothing about the fold may.
      expect(screen.getAllByRole("columnheader")).toHaveLength(3);
      expect(headerText()).not.toContain("Due");
      expect(screen.getAllByRole("row")[1]!.textContent).toContain("Due:");
    } finally {
      restore();
    }
  });

  it("still folds when the resize is the first thing that measured it", () => {
    // The other half of the same guard: made too strict it would stop recording
    // altogether, and a table narrowed after mount would never fold at all.
    const { resizeTo, restore } = stubMeasuredLayout(WIDTHS, 900);
    try {
      render(<DataTable rows={rows} columns={columns} rowActions={<span>Pay</span>} />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(4);

      resizeTo(350);
      expect(screen.getAllByRole("columnheader")).toHaveLength(3);
      expect(headerText()).not.toContain("Due");

      // …and widening gives the column back, off the edges recorded while it
      // was still shown.
      resizeTo(900);
      expect(screen.getAllByRole("columnheader")).toHaveLength(4);
      expect(headerText()).toContain("Due");
    } finally {
      restore();
    }
  });
});
