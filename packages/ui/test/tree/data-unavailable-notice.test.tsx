// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const NOTICE = "Data didn't load";

/**
 * The view a failed load and a genuinely empty dataset produce the SAME way: a
 * table bound to a query result that isn't there renders its own empty state
 * ("No data"), which is exactly why the failure has to be said out loud —
 * otherwise the user cannot tell "this couldn't load" from "you have nothing".
 */
function spendingTree(extras: Record<string, unknown> = {}): UIPayload {
  return {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["table"] },
      {
        id: "table",
        component: "DataTable",
        props: { columns: [{ key: "merchant" }, { key: "amount" }], rows: { $path: "/spend/rows" } },
      },
    ],
    ...extras,
  } as UIPayload;
}

/** The same app with a second, independent value in it — the shape a PARTIAL
 *  failure takes on screen: one binding resolved, one still blank. */
function mixedTree(extras: Record<string, unknown> = {}): UIPayload {
  return {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["total", "table"] },
      { id: "total", component: "Text", props: { text: { $path: "/spend/total" } } },
      {
        id: "table",
        component: "DataTable",
        props: { columns: [{ key: "merchant" }, { key: "amount" }], rows: { $path: "/spend/rows" } },
      },
    ],
    ...extras,
  } as UIPayload;
}

describe("the data-unavailable notice (render-seam F6)", () => {
  it("says the view could not load its data, in the user's own words", () => {
    render(<TreeView tree={spendingTree({ dataUnavailable: true })} components={{}} onAction={ok} />);

    const notice = screen.getByRole("note", { name: NOTICE });
    // Consumer voice: no tool names, no file paths, no codes.
    expect(notice.textContent).toContain("Some values below couldn't load");
    expect(notice.textContent).toContain("isn't your data being empty");
    expect(notice.textContent).not.toMatch(/vendo|app\.vendo|authored|query|tool/i);
    // The settled view still renders underneath — the notice is a header on the
    // app, never a replacement for it.
    expect(screen.getByText("No data")).not.toBeNull();
  });

  it("never claims the whole view is blank when only SOME of the data failed", () => {
    // The marker fires for ANY failed query, so this is the mainline case, not a
    // corner: two queries, one refused by the guard, and the payload settles with
    // the other one's real number in it (measured in the apps data-unavailable
    // suite: `{ data: { spend: { total: 4210 } }, dataUnavailable: true }`).
    // Copy that says "the values below are blank" is then read next to $4,210 of
    // the person's own spending — the notice itself telling the lie it exists to
    // prevent.
    render(
      <TreeView
        tree={mixedTree({ dataUnavailable: true })}
        components={{}}
        data={{ spend: { total: 4210 } }}
        onAction={ok}
      />,
    );

    // The number that DID arrive is on screen…
    expect(screen.getByText("4210")).not.toBeNull();
    // …and the blank one is still blank, which is what the notice is about.
    expect(screen.getByText("No data")).not.toBeNull();
    const notice = screen.getByRole("note", { name: NOTICE });
    expect(notice.textContent).toContain("Some values below couldn't load");
    expect(notice.textContent).not.toMatch(/values below are blank|\ball\b|\bevery\b|\bnothing\b/i);
  });

  it("says NOTHING for a genuinely empty dataset — the whole point of the marker", () => {
    render(<TreeView tree={spendingTree()} components={{}} onAction={ok} />);

    // Same empty table, no claim that anything failed.
    expect(screen.getByText("No data")).not.toBeNull();
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });

  it("says nothing when the data DID load", () => {
    render(
      <TreeView
        tree={spendingTree()}
        components={{}}
        data={{ spend: { rows: [{ merchant: "Maple Coffee", amount: 4.5 }] } }}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Maple Coffee")).not.toBeNull();
    expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
  });

  it("tolerates a malformed marker — only exactly `true` speaks", () => {
    for (const value of ["yes", 1, {}, null]) {
      render(<TreeView tree={spendingTree({ dataUnavailable: value })} components={{}} onAction={ok} />);
      expect(screen.queryByRole("note", { name: NOTICE })).toBeNull();
      cleanup();
    }
  });
});
