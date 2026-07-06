import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VendoThemeProvider } from "../../theme/VendoThemeProvider.js";
import { tableDescriptor } from "./descriptor.js";
import { Table } from "./impl.js";

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
      <VendoThemeProvider>
        <Table
          columns={[{ key: "name", label: "Name" }, { key: "amt", label: "Amount" }]}
          rows={[{ name: "Alice", amt: 42 }]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

// Per-column formats (voice data-fidelity): data-bound refreshable views bind
// RAW tool rows into the Table, so declared field formats must be applied at
// RENDER time — deterministically, surviving pin/reopen refresh — not by the
// model that authored the view.
describe("per-column format", () => {
  it("schema accepts the FieldFormat vocabulary and rejects unknown formats", () => {
    const ok = tableDescriptor.propsSchema.safeParse({
      columns: [{ key: "amount", label: "Amount", format: "cents" }],
      rows: [{ amount: 285000 }],
    });
    expect(ok.success).toBe(true);
    const bad = tableDescriptor.propsSchema.safeParse({
      columns: [{ key: "amount", label: "Amount", format: "euros" }],
      rows: [{ amount: 1 }],
    });
    expect(bad.success).toBe(false);
  });

  it("renders integer cents as dollars (285000 → $2,850.00)", () => {
    render(
      <VendoThemeProvider>
        <Table
          columns={[
            { key: "category", label: "Category" },
            { key: "amount", label: "Amount", format: "cents" },
          ]}
          rows={[
            { category: "housing", amount: 285000 },
            { category: "refund", amount: -1199 },
          ]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.getByText("$2,850.00")).toBeInTheDocument();
    expect(screen.getByText("-$11.99")).toBeInTheDocument();
    expect(screen.queryByText("285000")).toBeNull();
  });

  it("passes non-numbers through untouched in a cents column", () => {
    render(
      <VendoThemeProvider>
        <Table
          columns={[{ key: "amount", label: "Amount", format: "cents" }]}
          rows={[{ amount: "$40.18" }]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.getByText("$40.18")).toBeInTheDocument();
  });

  it("renders percent values with a % sign, as-is", () => {
    render(
      <VendoThemeProvider>
        <Table
          columns={[{ key: "apr", label: "APR", format: "percent" }]}
          rows={[{ apr: 23.99 }]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.getByText("23.99%")).toBeInTheDocument();
  });

  it("renders an iso-date as the literal day it names, never timezone-shifted", () => {
    render(
      <VendoThemeProvider>
        <Table
          columns={[{ key: "due", label: "Due", format: "iso-date" }]}
          rows={[{ due: "2026-07-05" }]}
        />
      </VendoThemeProvider>,
    );
    // Rendered from the string's own Y/M/D parts — "Jul 5, 2026" in every timezone.
    expect(screen.getByText("Jul 5, 2026")).toBeInTheDocument();
  });

  it("renders an iso-datetime in the viewer's local date", () => {
    const value = "2026-07-05T23:30:00.000Z";
    render(
      <VendoThemeProvider>
        <Table
          columns={[{ key: "at", label: "When", format: "iso-datetime" }]}
          rows={[{ at: value }]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.getByText(new Date(value).toLocaleDateString("en-US"))).toBeInTheDocument();
  });
});

// Regression: data-bound refreshable views feed the Table RAW tool rows, which
// carry nested fields (statusTimeline arrays, metadata objects). The Table
// renders the DECLARED columns and ignores everything else — it must not
// reject the whole row set (context-engineering follow-up, live voice check).
describe("rich raw rows (data-bound refreshable views)", () => {
  it("renders declared scalar columns and ignores nested undeclared fields", () => {
    render(
      <VendoThemeProvider>
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
        />
      </VendoThemeProvider>,
    );
    expect(screen.queryByTestId("vendo-invalid-props")).toBeNull();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(screen.getByText("-1199")).toBeInTheDocument();
  });

  it("renders a non-scalar cell for a DECLARED column as an em dash, not JSON", () => {
    render(
      <VendoThemeProvider>
        <Table
          columns={[{ key: "statusTimeline", label: "Status" }]}
          rows={[{ statusTimeline: [{ state: "Posted" }] }]}
        />
      </VendoThemeProvider>,
    );
    expect(screen.queryByTestId("vendo-invalid-props")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
