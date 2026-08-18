// @vitest-environment jsdom
/**
 * Model-built table rows across the seam they really have to cross.
 *
 * A `<TableRow>` is written in TSX, serialized by the screen VM, flattened the
 * way the server flattens it, and painted by the renderer into the `<tr>`
 * DataTable drew — four hands, and nothing here is stubbed on any of them: real
 * sucrase, the real QuickJS engine from `@vendoai/apps/contract`, the real
 * `flattenTree`, the real `PayloadView` and the real Kit. The only double is the
 * host's `onAction`, which is the host's half by definition.
 *
 * The failure it exists to catch is the one the 2026-08-16 benchmark found in
 * every model: a cents field bound by NAME, printed 100x too large, past every
 * gate. The ÷100 and the currency both have to run in the VM — off the host's own
 * `Intl`, borrowed across the wall — and the text they produce has to arrive in
 * the right column of the right row, whether the row was painted by hand as a
 * `<TableRow>` or written once as a function of the row.
 */
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { transform } from "sucrase";
import { bootScreen, flattenTree, warmScreenEngine } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type Json, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { PayloadView } from "../../src/tree/index.js";

afterEach(cleanup);

beforeAll(async () => {
  await warmScreenEngine();
}, 30_000);

const compile = (tsx: string): string =>
  transform(tsx, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "automatic" }).code;

const CATALOG = ["Stack", "Text", "Button", "DataTable", "TableRow"];

/** Cents, the way a host's API really hands them over. */
const ACCOUNTS = [
  { id: "a1", name: "Checking", balance_cents: 128_450 },
  { id: "a2", name: "Savings", balance_cents: 900_125 },
];

const BALANCES = `
import { Button, DataTable, Text, TableRow, tools, useQuery } from "@vendo/screen";

const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Balances() {
  const accounts = useQuery("list_accounts");
  return (
    <DataTable
      rows={accounts.data}
      columns={[{ key: "name", label: "Account" },
                { key: "balance_cents", label: "Balance", align: "end" },
                { label: "", align: "end" }]}
      sortBy="balance_cents desc"
    >
      {accounts.data.map((a) => (
        <TableRow key={a.id}>
          <Text text={a.name} />
          <Text text={money(a.balance_cents)} />
          <Button label={"Cancel " + a.name} onClick={() => tools.cancel_transfer({ id: a.id })} />
        </TableRow>
      ))}
    </DataTable>
  );
}
`;

/** The screen's first paint, serialized and flattened exactly as the server
 *  serves it, plus the interactive half that can produce the next one. */
const served = (tsx: string) => {
  const compiledSource = compile(tsx);
  const queries = { list_accounts: { data: ACCOUNTS } };
  const boot = bootScreen({ compiledSource, queries, catalog: CATALOG, now: Date.UTC(2026, 7, 17) });
  try {
    const tree = boot.tree();
    const flat = flattenTree(tree);
    return {
      tree,
      payload: {
        formatVersion: VENDO_TREE_FORMAT,
        root: flat.root,
        nodes: Object.values(flat.nodes),
        interactive: { compiledSource, queries },
      } as unknown as UIPayload,
    };
  } finally {
    boot.dispose();
  }
};

interface Call { nodeId: string; action: string; payload?: Json }

const paint = (tsx: string) => {
  const calls: Call[] = [];
  const { tree, payload } = served(tsx);
  const view = render(
    <PayloadView
      payload={payload}
      components={{}}
      onAction={async (call: Call): Promise<ToolOutcome> => {
        calls.push(call);
        return { status: "ok", output: null };
      }}
    />,
  );
  return { tree, calls, ...view };
};

const grid = (): string[][] =>
  screen.getAllByRole("row").slice(1).map((row) =>
    within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""));

describe("a model-built table row, VM to paint", () => {
  it("serializes each row as an ordinary node — nothing in the VM had to learn about tables", () => {
    const { tree } = served(BALANCES);
    expect(tree.component).toBe("DataTable");
    // A mapped element is N keyed children, and the row is a plain node whose
    // `type` was the catalog's own string. No slot sigil, no props.
    expect(tree.children.map((child) => typeof child === "string" ? child : `${child.component}:${child.key}`))
      .toEqual(["TableRow:a1", "TableRow:a2"]);
    const first = tree.children[0];
    if (first === undefined || typeof first === "string") throw new Error("the first child is a TableRow node");
    expect(first.props).toEqual({});
    expect(first.children).toEqual([
      { component: "Text", props: { text: "Checking" }, children: [] },
      // The arithmetic AND the formatting both RAN, inside the VM: the cell
      // crosses the wire as the finished text the table prints.
      { component: "Text", props: { text: "$1,284.50" }, children: [] },
      {
        component: "Button",
        props: { label: "Cancel Checking", onClick: { $handler: "h1" } },
        children: [],
      },
    ]);
  });

  it("paints dollars in the right column of the right row, sorted", () => {
    paint(BALANCES);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/gu, "").trim()))
      .toEqual(["Account", "Balance", ""]);
    expect(grid()).toEqual([
      ["Savings", "$9,001.25", "Cancel Savings"],
      ["Checking", "$1,284.50", "Cancel Checking"],
    ]);
    // The cents never reach the surface — the whole point of the row.
    expect(screen.queryByText(/128,?450/u)).toBeNull();
  });

  it("puts each cell in its own column, with NOTHING between the row and its cells", () => {
    const { container } = paint(BALANCES);
    const body = container.querySelectorAll("tbody tr");
    expect(body).toHaveLength(2);
    // The row node's shell is no element at all. `<tr>` admits only cells, so
    // any element here — even a `display: contents` one — is invalid nesting
    // React warns about in every host developer's console, and a div that is
    // NOT boxless takes an anonymous table-cell box that slides every cell one
    // column out of its header.
    expect([...body[0]!.children].map((child) => child.tagName)).toEqual(["TD", "TD", "TD"]);
    expect([...body[0]!.querySelectorAll("td")].map((td) => td.style.textAlign))
      .toEqual(["left", "right", "right"]);
  });

  it("fires the pressed row's own handler back into the VM", async () => {
    const { calls } = paint(BALANCES);
    // The first row on screen is Savings — the sort moved it there, and its
    // button must still be Savings' button.
    fireEvent.click(within(screen.getAllByRole("row")[1]!).getByRole("button"));
    await waitFor(() => expect(calls.filter((call) => call.action === "cancel_transfer").map((call) => call.payload))
      .toEqual([{ id: "a2" }]));
  });
});

/**
 * The other half of the same crossing: the slot written ONCE, as a function of
 * the row.
 *
 * The VM calls it per row and emits a LIST of sigilled elements, each with its
 * own handler id; `flattenTree` carries the list in the prop; the renderer
 * reifies every entry; and the Kit picks this row's own out of it. Every hand is
 * the real one — a list that arrived in `rows` order and a table that paints in
 * sorted order is exactly where an index match shows the wrong row's button.
 */
const PER_ROW = `
import { Button, DataTable, Text, tools, useQuery } from "@vendo/screen";

const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Balances() {
  const accounts = useQuery("list_accounts");
  return (
    <DataTable
      rows={accounts.data}
      columns={[{ key: "name", label: "Account" },
                { key: "balance_cents", label: "Balance", align: "end",
                  cell: (a) => <Text text={money(a.balance_cents)} /> }]}
      sortBy="balance_cents desc"
      rowActions={(a) => <Button label={"Cancel " + a.name} onClick={() => tools.cancel_transfer({ id: a.id })} />}
    />
  );
}
`;

describe("a per-row slot, VM to paint", () => {
  it("emits one element per row, each carrying its own handler", () => {
    const { tree } = served(PER_ROW);
    const columns = tree.props.columns as Array<{ cell?: unknown }>;
    const cells = columns[1]!.cell as Array<{ props: Record<string, unknown> }>;
    expect(cells.map((cell) => cell.props.text)).toEqual(["$1,284.50", "$9,001.25"]);
    const actions = tree.props.rowActions as Array<{ props: Record<string, unknown> }>;
    expect(actions.map((action) => action.props.label)).toEqual(["Cancel Checking", "Cancel Savings"]);
    // Two rows, two handler ids — one for both was the defect: every Cancel
    // button cancelling the first row.
    const ids = actions.map((action) => (action.props.onClick as { $handler: string }).$handler);
    expect(new Set(ids).size).toBe(2);
  });

  it("paints each row's own cell and action, sorted, and fires the row it shows", async () => {
    const { calls } = paint(PER_ROW);
    expect(grid()).toEqual([
      ["Savings", "$9,001.25", "Cancel Savings"],
      ["Checking", "$1,284.50", "Cancel Checking"],
    ]);
    fireEvent.click(within(screen.getAllByRole("row")[1]!).getByRole("button"));
    await waitFor(() => expect(calls.filter((call) => call.action === "cancel_transfer").map((call) => call.payload))
      .toEqual([{ id: "a2" }]));
  });
});
