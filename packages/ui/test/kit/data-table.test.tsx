// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";
import { Button } from "../../src/kit/forms/button.js";
import { EnumBadge, Text } from "../../src/kit/values.js";

/** The one-line helpers a screen defines at the top of its own file. The table
 *  formats nothing, so the rows arrive holding finished text — which is what a
 *  screen prepares them as. */
const money = (dollars: number): string =>
  dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const year = new Date().getFullYear();
const rows = [
  { id: 1, client: { name: "Hartwell" }, amount: money(2500), dueDate: day(`${year}-03-14`), status: "overdue" },
  { id: 2, client: { name: "Acme" }, amount: money(900), dueDate: day(`${year}-01-02`), status: "paid" },
  { id: 3, client: { name: "Borealis" }, amount: money(1750), dueDate: day(`${year}-02-20`), status: "overdue" },
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
  { key: "amount", label: "Amount", align: "end" as const },
  { key: "dueDate", label: "Due" },
];

describe("DataTable", () => {
  it("renders rows, resolves dot-path keys, and shows each cell as prepared", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
    expect(screen.getByText("Mar 14")).toBeTruthy();
  });

  /** A column written as the bare KEY, which is the shorthand `Select.options`
   *  has always taken. It can only mean the key — the label already defaults
   *  from it — so the table reads it as the description it stands for, and a
   *  list may mix the two. */
  it("takes a column written as its bare key, beside a described one", () => {
    render(<DataTable rows={rows} columns={["client.name", { key: "amount", label: "Amount" }]} />);
    // The header is the humanized last path segment, exactly as an inferred
    // column's is, and the dot-path still resolves.
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.getByText("$2,500.00")).toBeTruthy();
  });

  /** `header` is the word a model reaches for first, and the spec used to spend a
   *  line warning against it — a warning that arrives too late to save the column,
   *  which shipped under a humanized key instead of the title it was given. */
  it("takes a column's header text spelled `header`", () => {
    render(<DataTable rows={rows} columns={[{ key: "client.name", header: "Client name" }, { key: "amount" }]} />);
    expect(screen.getByRole("columnheader", { name: "Client name" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Name" })).toBeNull();
  });

  it("lets `label` win where a column carries both", () => {
    render(<DataTable rows={rows} columns={[{ key: "client.name", label: "Client", header: "Client name" }]} />);
    expect(screen.getByRole("columnheader", { name: "Client" })).toBeTruthy();
  });

  it("applies an initial sortBy", () => {
    render(<DataTable rows={rows} columns={columns} sortBy="client.name asc" />);
    const bodyRows = screen.getAllByRole("row").slice(1); // drop header
    expect(bodyRows.map((r) => within(r).getAllByRole("cell")[0]?.textContent))
      .toEqual(["Acme", "Borealis", "Hartwell"]);
  });

  /**
   * A `cell` closure is where the formatting goes when the column must still
   * SORT: the row data stays the number the tool returned, so 900 leads — where
   * a column of prepared strings would put "$1,750.00" before "$900.00", as a
   * string sort does.
   */
  it("sorts a column numerically while its cell shows the figure formatted", () => {
    const invoices = [
      { id: 1, client: "Hartwell", amount_cents: 250_000 },
      { id: 2, client: "Acme", amount_cents: 90_000 },
      { id: 3, client: "Borealis", amount_cents: 175_000 },
    ];
    render(
      <DataTable
        rows={invoices}
        columns={[
          { key: "client", label: "Client" },
          {
            key: "amount_cents",
            label: "Amount",
            cell: invoices.map((row) => <Text text={money(row.amount_cents / 100)} />),
          },
        ]}
        sortBy="amount_cents asc"
      />,
    );
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows.map((r) => within(r).getAllByRole("cell")[0]?.textContent))
      .toEqual(["Acme", "Borealis", "Hartwell"]);
    expect(bodyRows.map((r) => within(r).getAllByRole("cell")[1]?.textContent))
      .toEqual(["$900.00", "$1,750.00", "$2,500.00"]);
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

  /**
   * A table with nothing in it is the MESSAGE, and nothing else. The columns are
   * inferred from the first row, so a table waiting on its query inferred them
   * from a row that is not there and painted a header row of no columns at all —
   * a <tr> holding nothing, above the sentence that already said everything.
   */
  it("paints no header row at all when there are no rows", () => {
    render(<DataTable rows={[]} emptyState="No overdue invoices" />);
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    // One row on the whole table: the message's own.
    expect(screen.getAllByRole("row")).toHaveLength(1);
    expect(screen.getByText("No overdue invoices")).toBeTruthy();
  });

  it("drops the header row even where the columns were declared", () => {
    render(<DataTable rows={[]} columns={columns} />);
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    expect(screen.queryByRole("columnheader", { name: /Client/u })).toBeNull();
  });

  // The one coercion the containers still read through: an ABSENT field is a
  // designed dash, never the word the record's own hole spells.
  it("renders an absent cell as a placeholder, never 'undefined'", () => {
    render(<DataTable rows={[{ id: 9, client: { name: "X" } }]} columns={columns} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText(/undefined/)).toBeNull();
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

  // Every filter compares against the text the cell SHOWS, which is the field as
  // the screen prepared it — so a person types what is in front of them ("Mar 14",
  // "$2,500") and the table answers, whatever shape the tool's own field had.
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
    // The values that EXIST, as the cells show them — one option per distinct cell.
    expect(within(filter).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["All Due", "Feb 20", "Jan 2", "Mar 14"]);

    fireEvent.change(filter, { target: { value: "Mar 14" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  /**
   * …and a column with a `cell` slot is no exception, though it used to be. The
   * dropdown read the raw field while the cells painted the slot, so a table of
   * "In progress" pills offered `in_progress` — a word nobody on that screen
   * could see, under a heading that promised the column.
   */
  it("offers a filter in the words a cell SLOT shows, not the token behind it", () => {
    const tickets = [
      { id: 1, title: "Login loop", status: "in_progress", stage: "triage" },
      { id: 2, title: "Slow export", status: "done", stage: "shipping" },
    ];
    const stages: Record<string, string> = { triage: "Needs triage", shipping: "Out for delivery" };
    render(
      <DataTable
        rows={tickets}
        columns={[
          { key: "title", label: "Title" },
          // A slot that computes its own label spells no words to read, so the
          // humanized token stands in — which is exactly what it paints.
          { key: "status", label: "Status", cell: tickets.map((t) => <EnumBadge value={t.status} />) },
          // A slot that DOES spell its words is read, so a label no humanizing
          // could have produced still reaches the dropdown.
          { key: "stage", label: "Stage", cell: tickets.map((t) => <Text>{stages[t.stage]}</Text>) },
        ]}
        filterableBy={["status", "stage"]}
      />,
    );
    const options = (name: string) =>
      within(screen.getByRole("combobox", { name })).getAllByRole("option").map((option) => option.textContent);
    expect(options("Filter by Status")).toEqual(["All Status", "Done", "In progress"]);
    expect(options("Filter by Stage")).toEqual(["All Stage", "Needs triage", "Out for delivery"]);

    // And the pick still narrows: the words the dropdown offers are the words the
    // filter compares, or it lists the column and answers with nothing.
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by Status" }), { target: { value: "In progress" } });
    expect(screen.getByText("Login loop")).toBeTruthy();
    expect(screen.queryByText("Slow export")).toBeNull();
  });

  it("never breaks a formatted figure across two lines", () => {
    render(<DataTable rows={rows} columns={columns} />);
    expect(screen.getByText("$2,500.00").closest("td")!.style.whiteSpace).toBe("nowrap");
    // The prose column is one line too: every cell the TABLE writes is, and the
    // frame scrolls to reach the ones that do not fit — see the one-line suite
    // below.
    expect(screen.getByText("Hartwell").closest("td")!.style.whiteSpace).toBe("nowrap");
  });

  it("re-declares the spacing scale on its own element for density=compact", () => {
    const { container } = render(<DataTable rows={rows} columns={columns} density="compact" />);
    const root = container.querySelector<HTMLElement>('[data-kit="DataTable"]')!;
    expect(root.style.getPropertyValue("--vendo-density-table-padding")).toBe("7px 10px");
  });

  /**
   * THE DEFAULT, and the ruling behind it: a column NEVER leaves on its own. The
   * table used to drop the ones it could not fit off its own measurement, on
   * every screen — and a column that leaves unasked is one the reader cannot know
   * to look for. MUI's DataGrid and AntD's Table both keep every column and
   * scroll the frame sideways; AntD's own hiding is opt-in per column. So the
   * frame scrolls, and the give-way machinery below waits to be asked.
   */
  it("keeps every column on a frame too narrow for them, and scrolls to reach them", () => {
    // Three 200px columns; 420px of room, so the third does not fit — and stays.
    const restore = stubLayout(200, 420);
    try {
      render(<DataTable rows={rows} columns={columns} />);
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toHaveLength(3);
      expect(headers.join()).toContain("Due");

      const firstRow = screen.getAllByRole("row")[1]!;
      expect(within(firstRow).getAllByRole("cell")).toHaveLength(3);
      // The column that did not fit is READ where it always was, not folded into
      // the first cell as another line of it.
      expect(firstRow.textContent).toContain("Mar 14");
      expect(firstRow.textContent).not.toContain("Due:");
    } finally {
      restore();
    }
  });

  /** The frame is what scrolls, so the table may grow past it — a `width` of 100%
   *  would read as a ceiling and squeeze the columns instead. */
  it("lets the table grow past the frame it sits in", () => {
    const { container } = render(<DataTable rows={rows} columns={columns} />);
    const table = container.querySelector("table")!;
    expect(table.style.minWidth).toBe("100%");
    expect(table.style.width).toBe("");
    expect(table.parentElement!.style.overflowX).toBe("auto");
  });

  // …and `fold` is how a screen asks for the give-way: the column that did not
  // fit rides in the FIRST cell, labelled, not in every cell.
  it("folds the columns that did not fit into the first cell when asked", () => {
    const restore = stubLayout(200, 420);
    try {
      render(<DataTable rows={rows} columns={columns} fold />);
      const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
      expect(cells).toHaveLength(2);
      expect(cells[0]!.textContent).toContain("Due: Mar 14");
      expect(cells[1]!.textContent).not.toContain("Due:");
    } finally {
      restore();
    }
  });

  it("keeps the first column however narrow the surface is", () => {
    const restore = stubLayout(200, 40);
    try {
      render(<DataTable rows={rows} columns={columns} fold />);
      expect(screen.getAllByRole("columnheader")).toHaveLength(1);
      const firstRow = screen.getAllByRole("row")[1]!;
      expect(firstRow.textContent).toContain("Amount: $2,500.00");
      expect(firstRow.textContent).toContain("Due: Mar 14");
    } finally {
      restore();
    }
  });

  /**
   * WHICH column gives way is a question about importance, not about position.
   * The table used to drop the rightmost one it could, so a screen that put the
   * status it was built to show last lost exactly that column on a phone. A
   * declared `priority` competes with the positions the other columns infer, and
   * the lowest number is the first to go.
   */
  it("gives up the least important column, not the last one", () => {
    const restore = stubLayout(200, 420);
    try {
      render(
        <DataTable
          rows={rows}
          columns={[columns[0]!, { ...columns[1]!, priority: 0 }, { ...columns[2]!, priority: 5 }]}
        />,
      );
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toHaveLength(2);
      expect(headers[0]).toContain("Client");
      // The AMOUNT column is the one that went, though it sits in the middle.
      expect(headers[1]).toContain("Due");
      expect(headers.join()).not.toContain("Amount");
      // …and the cells that are left still sit under their own headers.
      const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
      expect(cells.map((cell) => cell.textContent)).toEqual(["Hartwell", "Mar 14"]);
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
          fold
          columns={[
            ...columns,
            {
              key: "status",
              label: "Status",
              cell: rows.map((row) => <EnumBadge value={row.status} tones={{ overdue: "danger" }} />),
            },
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
      render(<DataTable rows={rows} columns={[columns[1]!, columns[0]!, columns[2]!]} fold />);
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
      render(<DataTable rows={rows} columns={columns} fold />);
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
      // `fold` so the second assertion still says something: a column that went
      // would leave its line in the first cell.
      render(<DataTable rows={rows} columns={columns} fold />);
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
      // `fold`, so the measurement is being asked a question at all: without it
      // every column renders whatever the arithmetic says, and this proves nothing.
      render(<DataTable rows={rows} columns={columns} fold />);
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
      render(<DataTable rows={rows} columns={columns} fold />);
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
      render(<DataTable rows={rows} columns={columns} rowActions={<span>Pay</span>} fold />);
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
      render(<DataTable rows={rows} columns={columns} rowActions={<span>Pay</span>} fold />);
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

/**
 * ONE LINE PER CELL — the 90-160px rows a judge measured.
 *
 * A wrapping cell hides its overflow in ROW HEIGHT: the auto table layout squeezes
 * the column, the sentence takes three lines, and the table reports that everything
 * fits. So every cell the table writes is one line, and the overflow it can no
 * longer hide goes where a person can act on it — the frame's own scrollbar.
 *
 * CLIPPING that line is a separate question, and `truncate` is the column's own
 * answer to it: a prose column capped with a `width` ellipsizes and keeps the
 * whole of itself in `title=`. Unasked, a cell is one line at its FULL width —
 * squeezing a column nobody capped is how a table hides a value without saying so.
 */
describe("DataTable — a cell on one line", () => {
  const note = "Quarterly reconciliation of the payables ledger against the bank feed";
  const notes = [{ id: 1, client: "Hartwell", note }];
  const cellFor = (text: string) => screen.getByText(text).closest("td")!;

  it("keeps a plain text cell on one line, unclipped and untitled", () => {
    render(<DataTable rows={notes} columns={[{ key: "client" }, { key: "note", label: "Note" }]} />);
    const cell = cellFor(note);
    expect(cell.style.whiteSpace).toBe("nowrap");
    expect(cell.style.textOverflow).toBe("");
    expect(cell.style.maxWidth).toBe("");
    expect(cell.title).toBe("");
  });

  it("clips the column that asked to, and keeps the whole text in its title", () => {
    render(
      <DataTable rows={notes} columns={[{ key: "client" }, { key: "note", label: "Note", width: 160, truncate: true }]} />,
    );
    const cell = cellFor(note);
    expect(cell.style.whiteSpace).toBe("nowrap");
    expect(cell.style.overflow).toBe("hidden");
    expect(cell.style.textOverflow).toBe("ellipsis");
    // Nothing is readable only by widening the window.
    expect(cell.title).toBe(note);
  });

  // A figure is one unbreakable atom — "Mar 14" split across two lines reads as
  // two values — and it is one whether or not the column said anything.
  it("keeps a formatted figure on one line", () => {
    render(<DataTable rows={rows} columns={[{ key: "amount" }]} />);
    const cell = cellFor("$2,500.00");
    expect(cell.style.whiteSpace).toBe("nowrap");
    expect(cell.style.textOverflow).toBe("");
  });

  // A slot holds ELEMENTS: there is no text to clip and none to put in a title,
  // and one line through a status pill would cut the pill.
  it("leaves a column that paints its own cells alone", () => {
    render(<DataTable rows={rows} columns={[{ key: "status", cell: <Text text="Overdue" /> }]} />);
    const cell = screen.getAllByText("Overdue")[0]!.closest("td")!;
    expect(cell.style.whiteSpace).toBe("");
    expect(cell.title).toBe("");
  });

  /** `width` is the cap the ellipsis needs to bite. Chromium honours a `max-width`
   *  on a <td> in the auto table layout and ignores a `width` on the <th> while the
   *  cell can still grow, so a declared width is written to both — measured in
   *  Chromium, where the th alone left the table 727px wide inside a 400px box. */
  it("writes a declared width to the header and caps the cell", () => {
    render(
      <DataTable rows={notes} columns={[{ key: "client" }, { key: "note", label: "Note", width: 160, truncate: true }]} />,
    );
    expect(screen.getByRole("columnheader", { name: "Note" }).style.width).toBe("160px");
    expect(cellFor(note).style.maxWidth).toBe("160px");
  });
});

/**
 * A column prints what the record holds, and nothing else. The table used to READ
 * an unformatted column — a `*_cents` name was money, an ISO-shaped string was a
 * date, a `*seconds` name was a duration, a hex string was mono — which is a
 * guess about what a field MEANS made from how it is spelled. Right most of the
 * time is a wrong figure the rest of the time, under a header that says nothing
 * happened. There is no token left to guess with either: the screen formats where
 * its rows are prepared, or in a `cell` function where the row is in scope.
 */
describe("DataTable — a column the screen left as it stands", () => {
  const deploys = [
    { id: 1, commit: "9f2c1ab", deployedAt: `${year}-08-12T14:05:00Z`, cost_cents: 452_900, duration_seconds: 157 },
    { id: 2, commit: "4e81d0c", deployedAt: `${year}-08-11T09:41:00Z`, cost_cents: 91_250, duration_seconds: 46 },
    { id: 3, commit: "b7a30f5", deployedAt: `${year}-08-09T22:18:00Z`, cost_cents: 1_204_075, duration_seconds: 9_480 },
  ];

  // The pin. A name is not an instruction: nothing divides here, so what is on
  // screen is exactly the number the tool returned.
  it("prints a cents-NAMED column as the raw number", () => {
    render(<DataTable rows={deploys} columns={[{ key: "cost_cents" }]} />);
    expect(screen.getByText("452900")).toBeTruthy();
    expect(screen.queryByText("$4,529.00")).toBeNull();
  });

  // …and where the screen DID prepare the figure, the table prints exactly that:
  // the ÷100 is the screen's to write or to skip, and nothing here second-guesses
  // which it meant.
  it("prints a cents-NAMED column the screen formatted as the screen wrote it", () => {
    render(
      <DataTable
        rows={deploys.map((row) => ({ ...row, cost_cents: money(row.cost_cents) }))}
        columns={[{ key: "cost_cents" }]}
      />,
    );
    expect(screen.getByText("$452,900.00")).toBeTruthy();
    expect(screen.queryByText("$4,529.00")).toBeNull();
  });

  it("prints a column of ISO stamps exactly as they arrive", () => {
    render(<DataTable rows={deploys} columns={[{ key: "deployedAt" }]} />);
    expect(screen.getByText(`${year}-08-12T14:05:00Z`)).toBeTruthy();
  });

  it("prints a seconds-NAMED column as the raw number", () => {
    render(<DataTable rows={deploys} columns={[{ key: "duration_seconds" }]} />);
    expect(screen.getByText("157")).toBeTruthy();
    expect(screen.queryByText("2m 37s")).toBeNull();
  });

  it("leaves a column of shas in the prose face", () => {
    render(<DataTable rows={deploys} columns={[{ key: "commit" }]} />);
    expect(screen.getByText("9f2c1ab").getAttribute("style")).not.toContain("--vendo-mono-family");
  });
});

/**
 * A slot written as a FUNCTION of the row.
 *
 * The VM calls it once per row and hands the table a list, one element per row,
 * in `rows` order — and the table paints in none of that order: it sorts, it
 * filters, it paginates. So which element lands on which row is matched by row
 * IDENTITY, and never by the place the row is painted in.
 */
describe("DataTable — a slot written as a function of the row", () => {
  const invoices = [
    { id: "in_1", client: "Hartwell", amount: 2_500 },
    { id: "in_2", client: "Acme", amount: 900 },
    { id: "in_3", client: "Borealis", amount: 1_750 },
  ];
  /** That map, done by hand (apps genui/component/vm-program.ts `emitSlot`). */
  const perRow = <T,>(of: (row: (typeof invoices)[number]) => T): T[] => invoices.map(of);
  const bodyRows = () => screen.getAllByRole("row").slice(1);
  const cancelButtons = () => bodyRows().map((row) => within(row).getByRole("button").textContent);

  it("gives every row its OWN action, closed over that row's data", () => {
    const cancelled: string[] = [];
    render(
      <DataTable
        rows={invoices}
        columns={[{ key: "client", label: "Client" }]}
        rowActions={perRow((row) => (
          <Button label={`Cancel ${row.client}`} onClick={() => cancelled.push(row.id)} />
        ))}
      />,
    );
    expect(cancelButtons()).toEqual(["Cancel Hartwell", "Cancel Acme", "Cancel Borealis"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel Acme" }));
    expect(cancelled).toEqual(["in_2"]);
  });

  /**
   * THE REGRESSION the identity match exists for. Sorting reorders
   * `row.original`, so the row painted first is the list's SECOND element —
   * matched by position, Acme's row would show and press Hartwell's Cancel.
   */
  it("keeps each row's own action through a sort", () => {
    const cancelled: string[] = [];
    render(
      <DataTable
        rows={invoices}
        columns={[{ key: "client", label: "Client" }, { key: "amount", label: "Amount" }]}
        sortBy="amount asc"
        rowActions={perRow((row) => (
          <Button label={`Cancel ${row.client}`} onClick={() => cancelled.push(row.id)} />
        ))}
      />,
    );
    expect(bodyRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent))
      .toEqual(["Acme", "Borealis", "Hartwell"]);
    expect(cancelButtons()).toEqual(["Cancel Acme", "Cancel Borealis", "Cancel Hartwell"]);

    fireEvent.click(within(bodyRows()[0]!).getByRole("button"));
    expect(cancelled).toEqual(["in_2"]);
  });

  it("paints a per-row cell against its own row, and one plain element on every row", () => {
    render(
      <DataTable
        rows={invoices}
        columns={[
          { key: "amount", label: "Amount", cell: perRow((row) => <Text text={money(row.amount / 100)} />) },
          { key: "client", label: "Flag", cell: <Text text="Open" /> },
        ]}
      />,
    );
    // The arithmetic ran where the row was in scope — the whole point of the
    // closure, and the 100x misread it replaces.
    expect(bodyRows().map((row) => within(row).getAllByRole("cell")[0]?.textContent))
      .toEqual(["$25.00", "$9.00", "$17.50"]);
    // A single element still paints on every row: that is what a stored screen
    // and a wire tree hold.
    expect(screen.getAllByText("Open")).toHaveLength(3);
  });
});
