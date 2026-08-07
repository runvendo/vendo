// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DateTime, EnumBadge, Money, Num, Percent, Text } from "../../src/kit/values.js";

describe("Money", () => {
  it("formats integer cents as currency", () => {
    render(<Money cents={123456} />);
    expect(screen.getByText("$1,234.56")).toBeTruthy();
  });

  it("renders a placeholder for NaN — never $NaN", () => {
    const { container } = render(<Money cents={Number.NaN} />);
    expect(container.textContent).toBe("—");
    expect(container.textContent).not.toContain("NaN");
  });
});

describe("DateTime", () => {
  it("formats a date-only string without slipping a day", () => {
    render(<DateTime value="2026-03-14" mode="date" />);
    expect(screen.getByText("Mar 14, 2026")).toBeTruthy();
  });

  it("renders a placeholder for an unparseable value", () => {
    const { container } = render(<DateTime value="nope" />);
    expect(container.textContent).toBe("—");
  });
});

describe("Percent + Num", () => {
  it("formats a ratio as a percentage", () => {
    render(<Percent value={0.42} />);
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("groups a large number", () => {
    render(<Num value={1234567} />);
    expect(screen.getByText("1,234,567")).toBeTruthy();
  });
});

describe("EnumBadge", () => {
  it("humanizes a snake_case enum value", () => {
    render(<EnumBadge value="past_due" />);
    expect(screen.getByText("Past due")).toBeTruthy();
  });

  it("honors an explicit label + tone map", () => {
    render(<EnumBadge value="overdue" labels={{ overdue: "OVERDUE" }} tones={{ overdue: "danger" }} />);
    const badge = screen.getByText("OVERDUE");
    expect(badge.getAttribute("data-tone")).toBe("danger");
  });

  it("renders nothing for an empty value", () => {
    const { container } = render(<EnumBadge value={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("Text", () => {
  it("renders a heading element for the heading variant", () => {
    render(<Text text="Overview" variant="heading" />);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
});
