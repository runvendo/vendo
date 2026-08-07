// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type Json, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree =>
  ({ formatVersion: VENDO_TREE_FORMAT, root: "root", nodes } as WalkTree);

/** One computed headline: average invoice value in cents. */
const nodes: WalkTree["nodes"] = [
  { id: "root", component: "Stack", children: ["headline"] },
  {
    id: "headline",
    component: "Text",
    props: { text: { $expr: 'sum(invoices, "amount_cents") / count(invoices)' } },
  },
];

const dataWith = (...cents: number[]): Record<string, Json> => ({
  invoices: cents.map((amount_cents, index) => ({ id: `i${index}`, amount_cents })),
});

describe("$expr bindings in the renderer", () => {
  it("re-evaluates the same $expr binding when the query data changes", () => {
    const view = render(
      <TreeView tree={tree(nodes)} components={{}} data={dataWith(1000, 3000)} onAction={ok} />,
    );
    expect(screen.getByText("2000")).toBeTruthy();

    // The tree is byte-identical; ONLY the data moved. A value computed once
    // and frozen (memoised on the tree, or resolved at generation time) would
    // still read 2000 here — that is what this assertion exists to catch.
    view.rerender(
      <TreeView tree={tree(nodes)} components={{}} data={dataWith(1000, 3000, 8000)} onAction={ok} />,
    );
    expect(screen.queryByText("2000")).toBeNull();
    expect(screen.getByText("4000")).toBeTruthy();

    view.rerender(<TreeView tree={tree(nodes)} components={{}} data={dataWith(500)} onAction={ok} />);
    expect(screen.getByText("500")).toBeTruthy();
  });

  it("holds the value empty while the data is still loading", () => {
    render(<TreeView tree={tree(nodes)} components={{}} data={{}} onAction={ok} />);

    expect(screen.queryByRole("note", { name: /data shape/i })).toBeNull();
    expect(document.querySelector('[data-vendo-node-id="headline"]')?.textContent).toBe("");
  });

  it("shows the contained data-shape notice when the expression cannot compute", () => {
    const mismatched: WalkTree["nodes"] = [
      { id: "root", component: "Stack", children: ["headline"] },
      { id: "headline", component: "Text", props: { text: { $expr: 'sum(invoices, "client_name")' } } },
    ];

    render(
      <TreeView
        tree={tree(mismatched)}
        components={{}}
        data={{ invoices: [{ client_name: "Acme" }] }}
        onAction={ok}
      />,
    );

    const notice = screen.getByRole("note", { name: /data shape/i });
    expect(notice.textContent).toContain("numeric");
    expect(notice.textContent).toContain("Acme");
  });
});
