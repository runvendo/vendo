// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Accordion } from "../../src/kit/feedback/accordion.js";
import { Callout } from "../../src/kit/feedback/callout.js";
import { Tabs } from "../../src/kit/feedback/tabs.js";

describe("Tabs (self-managing)", () => {
  it("shows the first panel and switches on click without any handler", () => {
    render(
      <Tabs
        tabs={[
          { label: "Overview", content: <p>overview body</p> },
          { label: "Details", content: <p>details body</p> },
        ]}
      />,
    );
    expect(screen.getByText("overview body")).toBeTruthy();
    expect(screen.queryByText("details body")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByText("details body")).toBeTruthy();
  });
});

describe("Callout", () => {
  it("renders a toned notice with its message", () => {
    render(<Callout tone="warning" title="Heads up">Three invoices are overdue.</Callout>);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-tone")).toBe("warning");
    expect(screen.getByText("Three invoices are overdue.")).toBeTruthy();
  });

  // Re-gate 2026-07-26: generated code passes tone="accent" (the tone the
  // sibling Badge/EnumBadge/Stat vocabularies teach) — it crashed the
  // destructure and sank four otherwise-honest arm-C rows into error boxes.
  it('renders tone="accent" as a first-class tone, never a crash', () => {
    render(<Callout tone="accent" title="Note">Highlighted information.</Callout>);
    const el = screen.getByRole("status");
    expect(el.getAttribute("data-tone")).toBe("accent");
    expect(screen.getByText("Highlighted information.")).toBeTruthy();
  });

  it("renders any unknown tone safely with the info fallback", () => {
    render(<Callout tone={"garbage" as never} title="Odd">Still visible.</Callout>);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Still visible.")).toBeTruthy();
  });

  it("does not pick up Object.prototype members for tones like 'constructor' (review)", () => {
    render(<Callout tone={"constructor" as never} title="Proto">Prototype-safe.</Callout>);
    const el = screen.getByRole("status");
    expect(screen.getByText("Prototype-safe.")).toBeTruthy();
    // The info fallback's accent color applied — not an undefined style.
    expect((el as HTMLElement).style.borderLeft).not.toContain("undefined");
  });
});

describe("Accordion (self-managing)", () => {
  it("toggles a section open and closed", () => {
    render(
      <Accordion
        items={[
          { label: "Terms", content: <p>the terms</p> },
          { label: "FAQ", content: <p>the faq</p> },
        ]}
      />,
    );
    expect(screen.queryByText("the terms")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Terms" }));
    expect(screen.getByText("the terms")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Terms" }));
    expect(screen.queryByText("the terms")).toBeNull();
  });
});
