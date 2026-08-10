// @vitest-environment jsdom
/**
 * An empty result is stated in WORDS, and nothing is offered for rows that do
 * not exist.
 *
 * Measured on genbench (2026-08-10): counting only screens that rendered, the
 * blind judge saw "an empty or zero result is stated in words" on 25% of Vendo's
 * screens against 95% of a raw HTML page's. The screens themselves said why —
 * `no-pending-transfers` kept a DATE/AMOUNT/STATUS header over a void, a blank
 * dropdown with no options, and a green "Cancel transfer" whose press fired
 * `cancel_transfer({})`; `spending-empty` put a 230px chart box around one line.
 * Every one of those is chrome for data that is not there, so the Kit — not a
 * sentence in the brief the author has to remember — is where it is refused.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";
import { LineChart } from "../../src/kit/charts/line.js";
import { Form } from "../../src/kit/forms/form.js";
import { Input } from "../../src/kit/forms/input.js";
import { Select } from "../../src/kit/forms/select.js";

const columns = [
  { key: "id", label: "ID" },
  { key: "status", label: "Status" },
];

describe("DataTable with no data", () => {
  it("states it in words, with no header row and no table to hold it", () => {
    render(<DataTable rows={[]} columns={columns} emptyState="No transfers to show" />);
    expect(screen.getByText("No transfers to show")).toBeTruthy();
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps its controls when a FILTER is what hid the rows, so the person can clear it", () => {
    render(<DataTable rows={[{ id: 1, status: "paid" }]} columns={columns} searchable emptyState="No transfers to show" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("No transfers to show")).toBeTruthy();
    expect(screen.getByRole("searchbox")).toBeTruthy();
    expect(screen.queryAllByRole("columnheader").length).toBeGreaterThan(0);
  });
});

describe("a chart with nothing to plot", () => {
  it("is sized to its sentence, not to the chart it stands in for", () => {
    const { container } = render(<LineChart data={[]} xKey="x" series={["v"]} height={220} emptyState="No spending yet" />);
    const box = container.querySelector('[data-kit="ChartEmpty"] > div') as HTMLElement;
    expect(screen.getByText("No spending yet")).toBeTruthy();
    expect(box.style.height).toBe("");
    expect(box.style.minHeight).toBe("");
  });
});

describe("a dropdown with nothing to choose", () => {
  it("says so instead of rendering a blank control", () => {
    render(<Select label="Transfer to cancel" options={[]} labelField="id" valueField="id" emptyState="No pending transfers to cancel" />);
    expect(screen.getByText("No pending transfers to cancel")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("takes its form's submit with it — the action cannot run without a value", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer to cancel" options={[]} valueField="id" />
      </Form>,
    );
    expect(screen.queryByRole("button", { name: "Cancel transfer" })).toBeNull();
  });

  it("leaves the submit alone once there is something to choose", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer to cancel" options={[{ id: "t1" }]} labelField="id" valueField="id" />
      </Form>,
    );
    expect(screen.getByRole("button", { name: "Cancel transfer" })).toBeTruthy();
  });

  it("says nothing about a form whose fields are typed rather than chosen", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Send">
        <Input label="Amount" />
      </Form>,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
