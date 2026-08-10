// @vitest-environment jsdom
/**
 * The Form ↔ bound-action seam: a `<Form onSubmit="a_tool">` must call that
 * tool WITH its fields.
 *
 * The generated shape below is copied from real benchmark output (a Select
 * inside a Form, `valueField="id"`, submit label "Cancel transfer"): the writer
 * reaches for it whenever a tool takes one row's id. Before the field name
 * reached the DOM and the closure read it back, that press fired
 * `cancel_transfer()` with no arguments — a screen that looks wired and is
 * dead. Both sides here are real: the product's TreeView binds the action, the
 * Kit's own Form and Select render the controls, and the assertion is the
 * argument the host would receive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type Json, type ToolOutcome } from "@vendoai/core";
import { TreeView, type WalkTree } from "../../src/tree/index.js";

afterEach(cleanup);

const transfers = [
  { id: "tr_1", to: "Ada", amount: 2500 },
  { id: "tr_2", to: "Grace", amount: 900 },
];

const formTree = (props: Record<string, Json>, fieldProps: Record<string, Json>): WalkTree => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "form",
  nodes: [
    { id: "form", component: "Form", source: "prewired", props, children: ["field"] },
    { id: "field", component: "Select", source: "prewired", props: fieldProps },
  ],
} as WalkTree);

describe("a Kit Form submits its fields to the bound tool", () => {
  const ok = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
  afterEach(() => ok.mockClear());

  it("sends the Select's value under its valueField — the shape the writer chose", () => {
    render(
      <TreeView
        tree={formTree(
          { onSubmit: { $action: "cancel_transfer" }, submitLabel: "Cancel transfer" },
          { label: "Transfer", options: transfers, labelField: "to", valueField: "id" },
        )}
        components={{}}
        onAction={ok}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    expect(ok).toHaveBeenCalledWith({ nodeId: "form", action: "cancel_transfer", payload: { id: "tr_1" } });
  });

  it("submits the option the user picked, not the first one", () => {
    render(
      <TreeView
        tree={formTree(
          { onSubmit: { $action: "cancel_transfer" }, submitLabel: "Cancel transfer" },
          { label: "Transfer", options: transfers, labelField: "to", valueField: "id" },
        )}
        components={{}}
        onAction={ok}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tr_2" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    expect(ok).toHaveBeenCalledWith({ nodeId: "form", action: "cancel_transfer", payload: { id: "tr_2" } });
  });

  it("lays the fields over the action's static payload", () => {
    render(
      <TreeView
        tree={formTree(
          { onSubmit: { $action: "cancel_transfer", payload: { reason: "duplicate" } }, submitLabel: "Cancel transfer" },
          { label: "Transfer", options: transfers, valueField: "id" },
        )}
        components={{}}
        onAction={ok}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    expect(ok).toHaveBeenCalledWith({ nodeId: "form", action: "cancel_transfer", payload: { reason: "duplicate", id: "tr_1" } });
  });

  it("leaves a nameless form's call exactly as it was", () => {
    render(
      <TreeView
        tree={formTree(
          { onSubmit: { $action: "cancel_transfer" }, submitLabel: "Cancel transfer" },
          { label: "Transfer", options: ["tr_1", "tr_2"] },
        )}
        components={{}}
        onAction={ok}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    expect(ok).toHaveBeenCalledWith({ nodeId: "form", action: "cancel_transfer" });
  });
});
