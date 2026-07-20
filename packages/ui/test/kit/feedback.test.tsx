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
