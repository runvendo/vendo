// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardList } from "../../src/kit/data/card-list.js";
import { DataTable } from "../../src/kit/data/data-table.js";
import { Stat } from "../../src/kit/data/stat.js";
import { Stack } from "../../src/kit/layout.js";
import { EnumBadge, Text } from "../../src/kit/values.js";

// A slot holds an ELEMENT, not a function of the row: the screen VM would
// serialize a function prop as a `$handler` door. So the container renders the
// SAME element once per row and publishes the row it is painting, and the value
// components inside name the field they read.
const rows = [
  { id: 1, client: { name: "Hartwell" }, number: "INV-1", status: "overdue" },
  { id: 2, client: { name: "Acme" }, number: "INV-2", status: "paid" },
];

const columns = [
  {
    key: "client.name",
    label: "Client",
    cell: (
      <Stack gap={2}>
        <Text field="client.name" />
        <Text field="number" variant="caption" />
      </Stack>
    ),
  },
  {
    key: "status",
    label: "Status",
    cell: <EnumBadge field="status" tones={{ overdue: "danger", paid: "success" }} />,
  },
];

describe("cell slots", () => {
  it("renders a column's slot once per row, against THAT row's fields", () => {
    render(<DataTable rows={rows} columns={columns} />);
    const [first, second] = screen.getAllByRole("row").slice(1);
    expect(within(first!).getByText("Hartwell")).toBeTruthy();
    expect(within(first!).getByText("INV-1")).toBeTruthy();
    expect(within(second!).getByText("Acme")).toBeTruthy();
    // One element, two rows, two different values — and two different tones.
    expect(within(first!).getByText("Overdue").getAttribute("data-tone")).toBe("danger");
    expect(within(second!).getByText("Paid").getAttribute("data-tone")).toBe("success");
  });

  // The slot changes what a cell SHOWS, never what the column IS: sorting,
  // filtering and search still run off `key` + `format`.
  it("still filters a slotted column on its key", () => {
    render(<DataTable rows={rows} columns={columns} filterableBy={["status"]} />);
    const filter = screen.getByRole("combobox", { name: "Filter by Status" });
    expect(within(filter).getByRole("option", { name: "overdue" })).toBeTruthy();

    fireEvent.change(filter, { target: { value: "overdue" } });
    expect(screen.getByText("Hartwell")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.queryByText("Paid")).toBeNull();
  });

  it("searches a slotted column on the text its key produces", () => {
    render(<DataTable rows={rows} columns={columns} searchable />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "paid" } });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.queryByText("Hartwell")).toBeNull();
  });

  it("renders a CardList field's slot per item, keeping the label", () => {
    render(
      <CardList
        items={rows}
        titleField="client.name"
        fields={[{ key: "status", label: "Status", cell: <EnumBadge field="status" tones={{ overdue: "danger" }} /> }]}
      />,
    );
    expect(screen.getAllByText("Status")).toHaveLength(2); // one label per card
    expect(screen.getByText("Overdue").getAttribute("data-tone")).toBe("danger");
    expect(screen.getByText("Paid").getAttribute("data-tone")).toBe("neutral");
  });

  it("renders Stat's children under the value", () => {
    render(
      <Stat label="Balance" value={2500} format="money" trend="+12% MoM">
        <Text text="last 30 days" variant="caption" />
      </Stat>,
    );
    const tile = screen.getByLabelText("Balance");
    const value = within(tile).getByText("$2,500.00");
    const child = within(tile).getByText("last 30 days");
    // DOCUMENT_POSITION_FOLLOWING — "under" is document order, not just nesting.
    expect(value.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
