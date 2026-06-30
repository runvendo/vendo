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
