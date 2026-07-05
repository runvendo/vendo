// @vitest-environment jsdom
/** Brand-tier increments 4+5: the audit's catalog gaps (F11).
 *  Progress, Donut (+legend), KeyValue, Actions, EmptyState. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { progressDescriptor } from "../components/Progress/descriptor";
import { Progress } from "../components/Progress/impl";
import { donutDescriptor } from "../components/Donut/descriptor";
import { Donut } from "../components/Donut/impl";
import { keyValueDescriptor } from "../components/KeyValue/descriptor";
import { KeyValue } from "../components/KeyValue/impl";
import { actionsDescriptor } from "../components/Actions/descriptor";
import { Actions } from "../components/Actions/impl";
import { emptyStateDescriptor } from "../components/EmptyState/descriptor";
import { EmptyState } from "../components/EmptyState/impl";

describe("Progress", () => {
  it("schema accepts a budget bar and rejects negative values", () => {
    expect(progressDescriptor.propsSchema.safeParse({ label: "Dining budget", value: 318, max: 500 }).success).toBe(true);
    expect(progressDescriptor.propsSchema.safeParse({ value: -1 }).success).toBe(false);
  });
  it("renders a fill proportional to value/max, capped at 100%", () => {
    const { container, rerender } = render(<Progress label="Dining" value={250} max={500} />);
    const fill = container.querySelector('[data-progress-fill]') as HTMLElement;
    expect(fill.style.width).toBe("50%");
    rerender(<Progress label="Dining" value={900} max={500} />);
    expect((container.querySelector('[data-progress-fill]') as HTMLElement).style.width).toBe("100%");
  });
});

describe("Donut", () => {
  const slices = [
    { label: "Housing", value: 2850 },
    { label: "Transport", value: 507 },
    { label: "Dining", value: 318 },
  ];
  it("schema accepts slices with optional hex color and rejects empty slices", () => {
    expect(donutDescriptor.propsSchema.safeParse({ slices }).success).toBe(true);
    expect(donutDescriptor.propsSchema.safeParse({ slices: [] }).success).toBe(false);
    expect(donutDescriptor.propsSchema.safeParse({ slices: [{ label: "x", value: 1, color: "not-hex" }] }).success).toBe(false);
  });
  it("renders one arc per slice and a legend row per slice", () => {
    const { container } = render(<Donut slices={slices} centerLabel="Total" centerValue="$3,675" />);
    expect(container.querySelectorAll("svg path").length).toBe(3);
    expect(screen.getByText("Housing")).toBeTruthy();
    expect(screen.getByText("$3,675")).toBeTruthy();
  });
  it("legend can be disabled", () => {
    const { container } = render(<Donut slices={slices} legend={false} />);
    expect(container.querySelector('[data-donut-legend]')).toBeNull();
  });
});

describe("KeyValue", () => {
  it("renders label/value rows with tabular values", () => {
    render(
      <KeyValue
        title="Transaction"
        rows={[
          { label: "Merchant", value: "DoorDash" },
          { label: "Amount", value: "$87.00", emphasis: true },
        ]}
      />,
    );
    expect(screen.getByText("Merchant")).toBeTruthy();
    expect(screen.getByText("$87.00")).toBeTruthy();
  });
  it("schema rejects empty rows", () => {
    expect(keyValueDescriptor.propsSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});

describe("Actions", () => {
  const actions = [{ label: "Freeze card", action: "freeze_card", payload: { cardId: "c1" } }];
  it("dispatches through the runtime-provided vendo closure", async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });
    render(<Actions actions={actions} vendo={{ dispatch }} />);
    fireEvent.click(screen.getByRole("button", { name: "Freeze card" }));
    expect(dispatch).toHaveBeenCalledWith({ action: "freeze_card", payload: { cardId: "c1" } });
  });
  it("renders disabled buttons when no dispatch capability is present (stub renderer)", () => {
    render(<Actions actions={actions} />);
    expect((screen.getByRole("button", { name: "Freeze card" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("accepts the danger variant for destructive actions", () => {
    expect(actionsDescriptor.propsSchema.safeParse({ actions: [{ label: "Freeze", action: "freezeCard", variant: "danger" }] }).success).toBe(true);
  });
  it("schema caps at 4 actions and requires an action name", () => {
    expect(actionsDescriptor.propsSchema.safeParse({ actions: [] }).success).toBe(false);
    expect(actionsDescriptor.propsSchema.safeParse({ actions: Array(5).fill(actions[0]) }).success).toBe(false);
    expect(actionsDescriptor.propsSchema.safeParse({ actions: [{ label: "x", action: "" }] }).success).toBe(false);
  });
});

describe("Donut single-slice (review finding)", () => {
  it("renders a full ring for a single 100% slice instead of a degenerate arc", () => {
    const { container } = render(<Donut slices={[{ label: "Housing", value: 100 }]} />);
    // A single slice must render as a <circle> (an SVG arc with coincident
    // endpoints renders NOTHING per spec).
    expect(container.querySelector("svg circle")).not.toBeNull();
  });
});

describe("Actions error surfacing (review finding)", () => {
  const actions = [{ label: "Freeze card", action: "freeze_card" }];
  it("shows an inline error when an approved dispatch actually fails", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("action failed (404)"));
    render(<Actions actions={actions} vendo={{ dispatch }} />);
    fireEvent.click(screen.getByRole("button", { name: "Freeze card" }));
    expect(await screen.findByText(/could not complete/i)).toBeTruthy();
  });
  it("stays quiet when the user declines the approval", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("action declined"));
    render(<Actions actions={actions} vendo={{ dispatch }} />);
    fireEvent.click(screen.getByRole("button", { name: "Freeze card" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/could not complete/i)).toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders empty and error variants", () => {
    const { rerender } = render(<EmptyState variant="empty" title="No transactions yet" message="They will appear here." />);
    expect(screen.getByText("No transactions yet")).toBeTruthy();
    rerender(<EmptyState variant="error" title="Could not load data" />);
    expect(screen.getByText("Could not load data")).toBeTruthy();
  });
  it("schema requires a title", () => {
    expect(emptyStateDescriptor.propsSchema.safeParse({ variant: "empty" }).success).toBe(false);
  });
});
