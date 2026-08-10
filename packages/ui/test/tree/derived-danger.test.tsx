// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const tree = (nodes: WalkTree["nodes"]): WalkTree => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: nodes[0]!.id,
  nodes,
});

/** Where danger red goes is DERIVED, not a judgement left to the writer:
 *  Button/Form default to the brand accent, so a submit bound to a destructive
 *  tool used to be structurally accent-green, and a negative amount rendered in
 *  the same dark text as a positive. */
describe("derived danger emphasis", () => {
  it("stamps the danger variant on a Button bound to a destructive tool", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["kill", "keep"] },
          { id: "kill", component: "Button", props: { label: "Cancel transfer", onClick: { $action: "transfers.cancelTransfer" } } },
          { id: "keep", component: "Button", props: { label: "Send transfer", onClick: { $action: "transfers.send" } } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel transfer" }).getAttribute("data-variant")).toBe("danger");
    expect(screen.getByRole("button", { name: "Send transfer" }).getAttribute("data-variant")).toBe("primary");
  });

  it("keeps an explicit variant on a destructive Button", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Button", props: { label: "Delete draft", variant: "secondary", onClick: { $action: "drafts.delete" } } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete draft" }).getAttribute("data-variant")).toBe("secondary");
  });

  it("carries the danger variant onto a destructive Form's submit", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Form", props: { submitLabel: "Close account", onSubmit: { $action: "accounts.close" } } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByRole("button", { name: "Close account" }).getAttribute("data-variant")).toBe("danger");
  });

  it("paints a negative money value in danger and leaves the positive alone", () => {
    render(
      <TreeView
        tree={tree([
          { id: "root", component: "Stack", children: ["loss", "gain"] },
          { id: "loss", component: "Stat", props: { label: "Net", value: -12884000, format: "money" } },
          { id: "gain", component: "Stat", props: { label: "Deposits", value: 12884000, format: "money" } },
        ])}
        components={{}}
        onAction={ok}
      />,
    );

    const value = (label: string): string =>
      screen.getByLabelText(label).querySelector("strong")!.getAttribute("style") ?? "";
    expect(value("Net")).toContain("--vendo-color-danger");
    expect(value("Deposits")).not.toContain("--vendo-color-danger");
  });
});
