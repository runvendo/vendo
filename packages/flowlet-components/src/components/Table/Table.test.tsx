import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowletThemeProvider } from "../../theme/FlowletThemeProvider";
import { tableDescriptor } from "./descriptor";
import { Table } from "./impl";

describe("Table", () => {
  it("schema requires columns and rows", () => {
    expect(tableDescriptor.propsSchema.safeParse({ columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }).success).toBe(true);
    expect(tableDescriptor.propsSchema.safeParse({ columns: [] }).success).toBe(false);
  });

  it("rejects rows array exceeding 1000 items", () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ a: i }));
    expect(tableDescriptor.propsSchema.safeParse({ columns: [{ key: "a", label: "A" }], rows }).success).toBe(false);
  });

  it("renders headers and cell values", () => {
    render(
      <FlowletThemeProvider>
        <Table
          columns={[{ key: "name", label: "Name" }, { key: "amt", label: "Amount" }]}
          rows={[{ name: "Alice", amt: 42 }]}
        />
      </FlowletThemeProvider>,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

// Regression: data-bound refreshable views feed the Table RAW tool rows, which
// carry nested fields (statusTimeline arrays, metadata objects). The Table
// renders the DECLARED columns and ignores everything else — it must not
// reject the whole row set (context-engineering follow-up, live voice check).
describe("rich raw rows (data-bound refreshable views)", () => {
  it("renders declared scalar columns and ignores nested undeclared fields", () => {
    render(
      <Table
        columns={[
          { key: "merchant", label: "Merchant" },
          { key: "amount", label: "Amount" },
        ]}
        rows={[
          {
            merchant: "Spotify",
            amount: -1199,
            statusTimeline: [{ state: "Posted", at: "2026-07-04" }],
            meta: { deep: true },
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("flowlet-invalid-props")).toBeNull();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText("-1199")).toBeInTheDocument();
  });

  it("renders a non-scalar cell for a DECLARED column as an em dash, not JSON", () => {
    render(
      <Table
        columns={[{ key: "statusTimeline", label: "Status" }]}
        rows={[{ statusTimeline: [{ state: "Posted" }] }]}
      />,
    );
    expect(screen.queryByTestId("flowlet-invalid-props")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
