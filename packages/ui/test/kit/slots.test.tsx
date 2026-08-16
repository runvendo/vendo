// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DonutChart } from "../../src/kit/charts/donut.js";
import { slotTooltip } from "../../src/kit/charts/sanitize.js";
import { CardList } from "../../src/kit/data/card-list.js";
import { DataTable } from "../../src/kit/data/data-table.js";
import { Stat } from "../../src/kit/data/stat.js";
import { Button } from "../../src/kit/forms/button.js";
import { Divider, Stack } from "../../src/kit/layout.js";
import { EnumBadge, Money, Text } from "../../src/kit/values.js";

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

/**
 * The half `slot-drift.test.tsx` cannot see. That guard proves a probe put in a
 * slot reaches the DOM, once; these are the slots that promise something MORE
 * than landing — a per-row painting, a three-way prop, a rule that had to bend
 * to let a slot in.
 */
describe("what a slot promises beyond landing", () => {
  it("paints rowActions once per row, against THAT row", () => {
    render(<DataTable rows={rows} columns={[{ key: "number" }]} rowActions={<Text field="client.name" />} />);
    const [first, second] = screen.getAllByRole("row").slice(1);
    // One element, two rows, two different values — the cell contract, on the
    // half of it that may be operated.
    expect(within(first!).getByText("Hartwell")).toBeTruthy();
    expect(within(second!).getByText("Acme")).toBeTruthy();
  });

  it("keeps the actions column out of the fold measurement", () => {
    // The trailing column never folds, so counting it as a data column left the
    // natural edges unmeasured and NOTHING folded — the columns past the width
    // would have gone back to scrolling out of sight.
    render(<DataTable rows={rows} columns={columns} rowActions={<Button label="Pay" />} />);
    const [header] = screen.getAllByRole("row");
    // Two data columns, plus the actions column — and the header cells still
    // line up with the body's.
    expect(within(header!).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(screen.getAllByRole("row")[1]!).getAllByRole("cell")).toHaveLength(3);
  });

  it("composes a chart tooltip against the hovered point", () => {
    // recharts hands its `content` the payload of whatever is under the pointer;
    // the slot reads it through `field`, exactly as a table cell reads its row.
    const Hover = slotTooltip(<Money field="amount" />);
    render(<Hover payload={[{ graphicalItemId: "amount", payload: { month: "Mar", amount: 1250 } }]} />);
    expect(screen.getByText("$1,250.00")).toBeTruthy();
  });

  it("lets a donut's legend be taken away, or replaced", () => {
    const data = [{ label: "Rent", value: 900 }];
    const props = { data, categoryKey: "label", valueKey: "value" } as const;

    // Three states, one prop: the built-in key, no key, and one of your own.
    const { rerender } = render(<DonutChart {...props} />);
    expect(screen.getByText("Rent")).toBeTruthy();

    rerender(<DonutChart {...props} legend={false} />);
    expect(screen.queryByText("Rent")).toBeNull();

    rerender(<DonutChart {...props} legend={<Text text="Rent only" />} />);
    expect(screen.getByText("Rent only")).toBeTruthy();
    expect(screen.queryByText("$900.00")).toBeNull();
  });

  it("labels a divider without hiding it from the reading order", () => {
    // The plain rule is decoration and stays `aria-hidden`; a labelled one is a
    // section break, and a break nobody can hear is not one.
    const { container } = render(<Divider label={<Text text="Earlier" />} />);
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.getByText("Earlier")).toBeTruthy();
    expect(container.querySelector("[aria-hidden]")).toBeNull();
  });
});
