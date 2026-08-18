/**
 * A <DataTable> row the model painted itself, and the four ways it goes blank.
 *
 * A row's children ARE its cells, placed in the TABLE's column order
 * (`packages/ui` table-row.tsx) — so where a row sits and how many cells it has
 * are the whole of whether it paints anything at all, and neither is something
 * the renderer can say. `TableRow` is in the `region` vocabulary like every
 * other brick, so nothing else in the floor refuses one written in a header.
 *
 * Measured through `kitNestingIssues`, which is the wire floor's `kit-nesting`
 * check and the screen gauntlet's `nesting` stage at once — one implementation,
 * both artifacts.
 */
import { describe, expect, it } from "vitest";
import { VENDO_TREE_FORMAT } from "@vendoai/core";
import { KIT_SPECS, type Tree } from "../../src/contract/index.js";
import { kitNestingIssues } from "../../src/server/checking/facts.js";

type Node = Tree["nodes"][number];

const node = (id: string, component: string, over: Partial<Node> = {}): Node =>
  ({ id, component, source: "prewired", ...over });

/** An element as the screen VM stamps one into a prop (vm-program.ts). */
const element = (component: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ $element: true, component, props: {}, children: [], ...over });

const messages = (nodes: Node[]): string[] =>
  kitNestingIssues({ formatVersion: VENDO_TREE_FORMAT, root: nodes[0]!.id, nodes })
    .map(({ where, message }) => `${where} ${message}`);

const columns = [{ key: "name", label: "Account" }, { key: "balance_cents", label: "Balance", align: "end" }];

/** The table with two columns and one two-cell row — the shape the rules below
 *  are departures from. */
const painted = (over: Partial<Node> = {}): Node[] => [
  node("t1", "DataTable", { props: { rows: [], columns }, children: ["r1"] }),
  node("r1", "TableRow", { children: ["c1", "c2"], ...over }),
  node("c1", "Text", { props: { text: "Checking" } }),
  node("c2", "Text", { props: { text: "$12.00" } }),
];

describe("a DataTable row the model painted", () => {
  it("passes one row per record with one cell per column", () => {
    expect(messages(painted())).toEqual([]);
  });

  it("names the two bricks the rules are written against", () => {
    // The rules hold "DataTable" and "TableRow" as strings; renaming a brick
    // must not leave them behind, the way the route check pins <Link>.
    for (const name of ["DataTable", "TableRow"]) {
      expect(KIT_SPECS.find((spec) => spec.name === name)?.takesChildren, name).toBe(true);
    }
  });

  it("refuses a row written outside a table, in the tree and in a slot", () => {
    const [loose] = messages([node("s1", "Stack", { children: ["r1"] }), node("r1", "TableRow", { children: [] })]);
    expect(loose).toContain('node "r1" writes <TableRow> outside a <DataTable>');
    expect(loose).toContain("it paints nothing at all");

    // `region` is every brick's name, so a row in a header slot is admitted by
    // the slot vocabulary and refused only by where it sits.
    const [slotted] = messages([node("c1", "Card", { props: { header: element("TableRow") } })]);
    expect(slotted).toContain('node "c1" prop "header" writes <TableRow> outside a <DataTable>');

    // …and a table written INTO a slot still holds its own rows.
    expect(messages([node("a1", "Accordion", {
      props: {
        items: [{
          label: "Accounts",
          content: element("DataTable", {
            props: { rows: [], columns },
            children: [element("TableRow", { children: [element("Text"), element("Text")] })],
          }),
        }],
      },
    })])).toEqual([]);
  });

  it("refuses a table child that is not a row", () => {
    const [message] = messages([
      node("t1", "DataTable", { props: { rows: [], columns }, children: ["b1"] }),
      node("b1", "Button", { props: { label: "Export" } }),
    ]);
    expect(message).toContain('node "t1" nests <Button> in <DataTable>');
    expect(message).toContain("a table's children are its ROWS");
    expect(message).toContain("toolbar={…} slot");
  });

  it("counts the cells against the columns, which is where the values slide", () => {
    // One extra child does not spill — it slides every value one column left of
    // the header that names it, and the table paints as if it were fine.
    const [message] = messages([
      ...painted({ children: ["c1", "c2", "c3"] }),
      node("c3", "Button", { props: { label: "Cancel" } }),
    ]);
    expect(message).toContain('node "t1" writes 3 cells in a <TableRow> where <DataTable> has 2 columns');
    expect(message).toContain("wrap several components in a <Stack>");

    // A short row is the same fault from the other side.
    expect(messages(painted({ children: ["c1"] }))[0])
      .toContain("writes 1 cells in a <TableRow> where <DataTable> has 2 columns");
  });

  it("refuses rows as children where nothing named the columns", () => {
    const found = messages([
      node("t1", "DataTable", { props: { rows: [] }, children: ["r1"] }),
      node("r1", "TableRow", { children: [] }),
    ]);
    expect(found[0]).toContain('node "t1" passes rows as children to <DataTable> with no columns');
    expect(found[0]).toContain("a row's cells are placed in column order");
    // The count rule stays quiet: with no columns there is nothing to count
    // against, and one repair is one message.
    expect(found).toHaveLength(1);
  });

  it("says nothing about a table with no children at all", () => {
    expect(messages([node("t1", "DataTable", { props: { rows: [] } })])).toEqual([]);
  });
});
