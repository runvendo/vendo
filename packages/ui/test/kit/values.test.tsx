// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/kit/format.js";
import { DateTime, EnumBadge, Money, Num, Percent, Text } from "../../src/kit/values.js";

describe("Money", () => {
  it("formats a dollar amount as currency", () => {
    render(<Money value={1234.56} />);
    expect(screen.getByText("$1,234.56")).toBeTruthy();
  });

  it("renders a placeholder for NaN — never $NaN", () => {
    const { container } = render(<Money value={Number.NaN} />);
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

  it("compact drops the YEAR and keeps the clock", () => {
    expect(formatDateTime("2026-08-12", { mode: "date" })).toBe("Aug 12, 2026");
    expect(formatDateTime("2026-08-12", { mode: "date", compact: true })).toBe("Aug 12");
    const stamp = formatDateTime(Date.UTC(2026, 7, 12, 15, 30), {
      mode: "datetime",
      compact: true,
      timeZone: "UTC",
    });
    expect(stamp).toContain("Aug 12");
    expect(stamp).toMatch(/3:30/);
    expect(stamp).not.toContain("2026");
    const { container } = render(<DateTime value="2026-08-12" mode="date" compact />);
    expect(container.textContent).toBe("Aug 12");
  });
});

describe("Percent + Num", () => {
  it("prints the percentage it is given, with no trailing zeros to show", () => {
    render(<Percent value={42} />);
    expect(screen.getByText("42%")).toBeTruthy();
  });

  // Rounding a figure nobody asked to round is a lie: an APR of 7.25% printed as
  // "7%" is a different rate.
  it("keeps the decimals the figure actually has", () => {
    expect(render(<Percent value={7.25} />).container.textContent).toBe("7.25%");
    expect(render(<Percent value={42} fractionDigits={1} />).container.textContent).toBe("42.0%");
  });

  // A host stores a rate as `apr_pct: 46.1`, and the ×100 convention turned that
  // into "4,610%" on screen. Nothing multiplies now.
  it("does not multiply a host's own 0-100 figure", () => {
    expect(render(<Percent value={46.1} />).container.textContent).toBe("46.1%");
  });

  it("groups a large number", () => {
    render(<Num value={1234567} />);
    expect(screen.getByText("1,234,567")).toBeTruthy();
  });

  it("carries its unit, so a latency is never a bare number", () => {
    const { container } = render(<Num value={842} unit="ms" />);
    expect(container.textContent).toBe("842 ms");
  });

  // "8.0 hours" printed as "8": Intl has had the option all along, the component
  // just never let a screen ask for it, and a column that alternates "8" and
  // "7.5" reads as two different precisions.
  it("keeps the trailing zeros the figure was written with", () => {
    expect(render(<Num value={8} minimumFractionDigits={1} unit="hours" />).container.textContent).toBe("8.0 hours");
    expect(render(<Num value={7.5} minimumFractionDigits={1} />).container.textContent).toBe("7.5");
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

  // `labels`/`tones` are model-authored records, so an enum value that happens to
  // name an Object.prototype member must read as ABSENT — a bare index hands
  // React `Object.prototype.toString`, a function, as the pill's label.
  it("an enum value that names a prototype member reads as data, never a method", () => {
    const { container } = render(<EnumBadge value="toString" labels={{}} tones={{}} />);
    expect(container.textContent).toBe("To string");
    expect(screen.getByText("To string").getAttribute("data-tone")).toBe("neutral");
  });
});

describe("Text", () => {
  it("renders a heading element for the heading variant", () => {
    render(<Text text="Overview" variant="heading" />);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });

  // An identifier is compared character by character, not read as prose — and
  // the face is the HOST's code font, never one the Kit picked.
  it("renders the code variant in the host's mono face", () => {
    render(<Text text="9f2c1ab" variant="code" />);
    expect(screen.getByText("9f2c1ab").getAttribute("style")).toContain("--vendo-mono-family");
  });

  // `active`, `isPaid`, `archived` — a boolean is one of the commonest values
  // there is, and React renders one as literally nothing.
  it("shows a boolean instead of swallowing it", () => {
    expect(render(<Text text={false} />).container.textContent).toBe("false");
    expect(render(<Text text={true} />).container.textContent).toBe("true");
  });

  // VALUES IN SENTENCES. With `text` the only way in, a screen that wanted a
  // figure inside a phrase hand-rolled `` `Overdue: $${x.toFixed(2)}` `` — an
  // unlocalised, uncurrencied, NaN-prone string, i.e. every failure the value
  // tier exists to make impossible, written around it.
  it("takes children, so a Kit figure can sit inside a sentence", () => {
    const { container } = render(
      <Text variant="caption">
        Overdue: <Money value={2500} /> across <Num value={12} /> invoices
      </Text>,
    );
    expect(container.textContent).toBe("Overdue: $2,500.00 across 12 invoices");
    // The nested elements are the value tier's own, not flattened text — and the
    // sentence around them still carries the variant it was given.
    expect(container.querySelector('[data-kit="Money"]')).toBeTruthy();
    expect(container.querySelector('[data-kit="Text"]')!.getAttribute("data-variant")).toBe("caption");
  });

  // A toned sentence painted its words red and the FIGURE stayed default: Money
  // re-declared `t.text` on itself, so the overdue balance — the one word in the
  // sentence carrying the meaning — was the only word that lost it.
  it("hands its color down to the figures inside it", () => {
    const { container } = render(
      <Text tone="danger">
        Balance: <Money value={2500} />
      </Text>,
    );
    expect(container.querySelector<HTMLElement>('[data-kit="Text"]')!.style.color).toContain("var(--vendo-color-danger");
    // The figure declares no color of its own, which is what lets the cascade
    // paint it — jsdom reports the declaration, a browser resolves it.
    expect(container.querySelector<HTMLElement>('[data-kit="Money"]')!.style.color).toBe("inherit");
  });

  it("takes a plain string child", () => {
    expect(render(<Text>Hi</Text>).container.textContent).toBe("Hi");
  });

  /** `text` wins where both are given: it is the prop every stored screen
   *  carries, and the renderer hands children to every node it paints. */
  it("keeps text winning over children", () => {
    expect(render(<Text text="From the prop">ignored</Text>).container.textContent).toBe("From the prop");
  });

  it("lands an object on the placeholder rather than throwing or spelling it out", () => {
    // `text={row.client}` where `client` is a record: as a React child that
    // throws, and through a formatter it reads "[object Object]".
    expect(render(<Text text={{ name: "Maple" } as never} />).container.textContent).toBe("—");
  });
});
