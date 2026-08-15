// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../../src/kit/feedback/empty-state.js";
import { Steps } from "../../src/kit/feedback/steps.js";
import { Button } from "../../src/kit/forms/button.js";

describe("EmptyState", () => {
  it("draws the icon, the headline, the reason and the action nested inside", () => {
    const { container } = render(
      <EmptyState icon="inbox" title="No invoices yet" description="They show up the moment one is issued.">
        <Button label="New invoice" />
      </EmptyState>,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("No invoices yet")).toBeTruthy();
    expect(screen.getByText("They show up the moment one is issued.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New invoice" })).toBeTruthy();
  });

  it("reads as intentional, not broken — the charts' dashed frame", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector('[data-kit="EmptyState"]')!.getAttribute("style")).toContain("dashed");
  });

  it("leaves a gap rather than a broken glyph for an icon name it does not have", () => {
    const { container } = render(<EmptyState icon="not-an-icon" title="Nothing here" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });
});

const steps = [{ label: "Details" }, { label: "Review", description: "We check the numbers" }, { label: "Done" }];

describe("Steps", () => {
  it("reads everything before the active step as done, and the rest as still to come", () => {
    const { container } = render(<Steps items={steps} active={1} />);
    const items = [...container.querySelectorAll("li")];
    expect(items.map((li) => li.dataset.stepState)).toEqual(["done", "current", "todo"]);
    // A done step is a check; an unreached one is still its number.
    expect(items[0]!.querySelector("svg")).toBeTruthy();
    expect(items[2]!.querySelector("svg")).toBeNull();
    expect(items[2]!.textContent).toContain("3");
    expect(screen.getByText("We check the numbers")).toBeTruthy();
  });

  it("names the current step for a screen reader", () => {
    const { container } = render(<Steps items={steps} active={2} />);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(container.querySelector('[aria-current="step"]')!.textContent).toContain("Done");
  });

  it("starts at the first step when none is named", () => {
    const { container } = render(<Steps items={steps} />);
    expect([...container.querySelectorAll("li")].map((li) => li.dataset.stepState))
      .toEqual(["current", "todo", "todo"]);
  });

  it("turns the progress rule with the orientation", () => {
    const rule = (orientation: "horizontal" | "vertical") =>
      render(<Steps items={steps} active={1} orientation={orientation} />)
        .container.querySelector("li")!.getAttribute("style")!;
    expect(rule("horizontal")).toContain("border-block-start");
    expect(rule("vertical")).toContain("border-inline-start");
  });
});
