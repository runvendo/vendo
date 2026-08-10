// @vitest-environment jsdom
/**
 * The consumer half of the four query states (the producer is the apps
 * `query-copy` suite): a Kit body bound to a query that contributed NOTHING says
 * so in words where its rows would be, instead of "No data" — which is the empty
 * ANSWER's copy, and a lie for a read that failed or has not arrived.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { PayloadView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const payload = (extras: Record<string, unknown> = {}): UIPayload => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["table"] },
    {
      id: "table",
      component: "DataTable",
      source: "prewired",
      props: { columns: [{ key: "name" }], rows: { $path: "/accounts/data" } },
    },
  ],
  queries: [{
    name: "accounts",
    tool: "maple_accounts_list",
    whileLoading: "Loading accounts…",
    onError: "Couldn't load accounts.",
  }],
  ...extras,
} as unknown as UIPayload);

describe("a query's words where its data would be", () => {
  it("says the read failed, rather than showing the empty-answer copy", () => {
    render(<PayloadView payload={payload()} components={{}} onAction={ok} />);

    expect(screen.getByText("Couldn't load accounts.")).not.toBeNull();
    expect(screen.queryByText("No data")).toBeNull();
  });

  it("says the read is still coming while the screen is still being built", () => {
    render(<PayloadView payload={payload({ streaming: true })} components={{}} onAction={ok} />);

    expect(screen.getByText("Loading accounts…")).not.toBeNull();
  });

  it("keeps the component's own empty state for an ANSWER that is empty", () => {
    render(
      <PayloadView payload={payload({ data: { accounts: { data: [] } } })} components={{}} onAction={ok} />,
    );

    expect(screen.getByText("No data")).not.toBeNull();
    expect(screen.queryByText("Couldn't load accounts.")).toBeNull();
  });

  it("shows the data when the data is there", () => {
    render(
      <PayloadView
        payload={payload({ data: { accounts: { data: [{ name: "Maple Checking" }] } } })}
        components={{}}
        onAction={ok}
      />,
    );

    expect(screen.getByText("Maple Checking")).not.toBeNull();
    expect(screen.queryByText("Couldn't load accounts.")).toBeNull();
  });
});
