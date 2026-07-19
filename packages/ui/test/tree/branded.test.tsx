// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VENDO_TREE_FORMAT_V2, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { defaultVendoTheme, themeCssVariables } from "../../src/theme.js";
import {
  Badge,
  BRANDED_COMPONENTS,
  Button,
  Card,
  Input,
  PREWIRED_COMPONENTS,
  Select,
  Stat,
  Table,
  Tabs,
  TreeView,
} from "../../src/tree/index.js";

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

describe("Card", () => {
  it("renders branded content from theme variables", () => {
    render(<Card title="Quarterly close" description="Ready for review">Supporting content</Card>);

    const card = screen.getByRole("article");
    expect(card.getAttribute("data-primitive")).toBe("Card");
    expect(screen.getByText("Quarterly close").getAttribute("data-card-title")).toBe("true");
    expect(screen.getByText("Supporting content")).toBeTruthy();
    expect(card.getAttribute("style")).toContain("--vendo-density-card-padding");
    expect(card.getAttribute("style")).toContain("--vendo-color-border");
  });
});

describe("Button", () => {
  it("uses accent tokens and invokes its bound action callback", () => {
    const onClick = vi.fn();
    render(<Button label="Approve" onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(button.getAttribute("data-primitive")).toBe("Button");
    expect(button.getAttribute("style")).toContain("--vendo-color-accent-text");
    expect(button.getAttribute("style")).toContain("--vendo-motion-duration");
  });
});

describe("Input", () => {
  it("seeds state as its value, displays edits, and invokes its bound change callback", () => {
    const onChange = vi.fn();
    render(<Input label="Client name" value="Hartwell" onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "Client name" });
    expect((input as HTMLInputElement).value).toBe("Hartwell");
    fireEvent.change(input, { target: { value: "Hartwell & Co" } });
    expect((input as HTMLInputElement).value).toBe("Hartwell & Co");
    expect(onChange).toHaveBeenCalledOnce();
    expect(input.closest('[data-primitive="Input"]')).not.toBeNull();
    expect(input.getAttribute("style")).toContain("--vendo-density-control-height");
  });
});

describe("Select", () => {
  it("renders JSON options, displays selection changes, and invokes its bound change callback", () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Status"
        value="open"
        options={["Draft", { label: "Open", value: "open" }, { label: "Paid", value: "paid", disabled: true }]}
        onChange={onChange}
      />,
    );

    const select = screen.getByRole("combobox", { name: "Status" });
    expect((select as HTMLSelectElement).value).toBe("open");
    expect((screen.getByRole("option", { name: "Paid" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "Draft" } });
    expect((select as HTMLSelectElement).value).toBe("Draft");
    expect(onChange).toHaveBeenCalledOnce();
    expect(select.closest('[data-primitive="Select"]')).not.toBeNull();
  });
});

describe("Table", () => {
  it("renders JSON columns and rows as an accessible branded table", () => {
    render(
      <Table
        caption="Open invoices"
        columns={[{ key: "client", label: "Client" }, { key: "amount", label: "Amount", align: "end" }]}
        rows={[{ id: "inv-1", client: "Acme", amount: "$4,200" }, { id: "inv-2", client: "Northstar", amount: null }]}
      />,
    );

    const table = screen.getByRole("table", { name: "Open invoices" });
    expect(table.closest('[data-primitive="Table"]')).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Amount" })).toBeTruthy();
    expect(screen.getByText("$4,200")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("Badge", () => {
  it("uses the danger theme token for danger tone", () => {
    render(<Badge label="Overdue" tone="danger" />);

    const badge = screen.getByText("Overdue");
    expect(badge.getAttribute("data-primitive")).toBe("Badge");
    expect(badge.getAttribute("data-tone")).toBe("danger");
    expect(badge.getAttribute("style")).toContain("--vendo-color-danger");
  });
});

describe("Stat", () => {
  it("renders its label, value, and supporting trend with heading typography", () => {
    render(<Stat label="Net revenue" value="$84,200" trend="12.4% this month" tone="accent" />);

    const stat = screen.getByRole("article", { name: "Net revenue" });
    expect(stat.getAttribute("data-primitive")).toBe("Stat");
    expect(screen.getByText("$84,200").getAttribute("style")).toContain("--vendo-heading-family");
    expect(screen.getByText("12.4% this month")).toBeTruthy();
  });
});

describe("Tabs", () => {
  it("marks the active tab and invokes the selected tab's bound callback", () => {
    const onActivity = vi.fn();
    render(
      <Tabs
        label="Account views"
        value="overview"
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "activity", label: "Activity", onSelect: onActivity },
        ]}
      />,
    );

    const list = screen.getByRole("tablist", { name: "Account views" });
    expect(list.getAttribute("data-primitive")).toBe("Tabs");
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(onActivity).toHaveBeenCalledOnce();
  });
});

describe("branded density and motion tokens", () => {
  it("derives compact spacing and zero-duration motion from the pinned theme enums", () => {
    const variables = themeCssVariables({ ...defaultVendoTheme, density: "compact", motion: "reduced" });

    expect(variables["--vendo-density"]).toBe("compact");
    expect(variables["--vendo-density-control-height"]).toBe("32px");
    expect(variables["--vendo-motion"]).toBe("reduced");
    expect(variables["--vendo-motion-duration"]).toBe("0ms");
  });
});

describe("branded primitive registration", () => {
  it("registers exactly eight branded components in the host-realm prewired table", () => {
    const names = ["Card", "Button", "Input", "Select", "Table", "Badge", "Stat", "Tabs"];
    expect(Object.keys(BRANDED_COMPONENTS)).toEqual(names);
    for (const name of names) expect(PREWIRED_COMPONENTS[name]).toBe(BRANDED_COMPONENTS[name]);
  });

  it("renders all eight outside the generated-component jail", () => {
    const tree: UIPayload = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["card", "button", "input", "select", "table", "badge", "stat", "tabs"] },
        { id: "card", component: "Card", source: "prewired", props: { title: "Card" } },
        { id: "button", component: "Button", source: "prewired", props: { label: "Button" } },
        { id: "input", component: "Input", source: "prewired", props: { label: "Input" } },
        { id: "select", component: "Select", source: "prewired", props: { label: "Select", options: ["One"] } },
        { id: "table", component: "Table", source: "prewired", props: { columns: ["Name"], rows: [{ Name: "Table" }] } },
        { id: "badge", component: "Badge", source: "prewired", props: { label: "Badge" } },
        { id: "stat", component: "Stat", source: "prewired", props: { label: "Stat", value: "42" } },
        { id: "tabs", component: "Tabs", source: "prewired", props: { tabs: ["Tabs"] } },
      ],
    };

    render(<TreeView tree={tree} components={{}} onAction={ok} />);

    for (const name of Object.keys(BRANDED_COMPONENTS)) {
      expect(document.querySelector(`[data-primitive="${name}"]`)).not.toBeNull();
    }
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("passes interactive action bindings through the existing renderer chokepoint", () => {
    const onAction = vi.fn(ok);
    const tree: UIPayload = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [
        { id: "root", component: "Tabs", source: "prewired", props: {
          label: "Views",
          value: "summary",
          tabs: [
            { label: "Summary", value: "summary" },
            { label: "Details", value: "details", onSelect: { $action: "fn:show-details", payload: { tab: "details" } } },
          ],
        } },
      ],
    };

    render(<TreeView tree={tree} components={{}} onAction={onAction} />);
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));

    expect(onAction).toHaveBeenCalledWith({
      nodeId: "root",
      action: "fn:show-details",
      payload: { tab: "details" },
    });
  });
});
