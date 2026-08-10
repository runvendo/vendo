// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** The seam: the renderer binds the action and the Kit paints the control, so
 *  the variant is only right if BOTH halves agree — no stub on either side. */
function renderTree(nodes: WalkTree["nodes"]) {
  const tree: WalkTree = { formatVersion: VENDO_TREE_FORMAT, root: nodes[0]?.id ?? "root", nodes };
  render(<TreeView tree={tree} components={{}} onAction={ok} />);
}

describe("a destructive action never wears the brand accent", () => {
  it("paints a Form whose submit cancels as danger", () => {
    renderTree([
      { id: "root", component: "Form", props: { onSubmit: { $action: "cancel_transfer" }, submitLabel: "Cancel transfer" } },
    ]);
    expect(screen.getByRole("button", { name: "Cancel transfer" }).getAttribute("data-variant")).toBe("danger");
  });

  it("keeps the accent on a Form that creates something", () => {
    renderTree([
      { id: "root", component: "Form", props: { onSubmit: { $action: "create_transfer" }, submitLabel: "Send" } },
    ]);
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("data-variant")).toBe("primary");
  });

  it("infers danger for a Button bound to a delete tool, and obeys an explicit variant", () => {
    renderTree([
      { id: "root", component: "Stack", children: ["inferred", "stated"] },
      { id: "inferred", component: "Button", props: { label: "Delete payee", onClick: { $action: "payees.delete" } } },
      { id: "stated", component: "Button", props: { label: "Remove later", onClick: { $action: "remove_payee" }, variant: "secondary" } },
    ]);
    expect(screen.getByRole("button", { name: "Delete payee" }).getAttribute("data-variant")).toBe("danger");
    expect(screen.getByRole("button", { name: "Remove later" }).getAttribute("data-variant")).toBe("secondary");
  });
});
