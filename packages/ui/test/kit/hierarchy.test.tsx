// @vitest-environment jsdom
/**
 * The two defaults that decide whether a generated screen reads as a screen:
 * something LEADS it, and a list row is one line tall. Both were regressions of
 * omission — a heading at body size, and body cells that wrapped while the
 * header did not — so both are pinned by their pixels-facing property, not by a
 * name.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "../../src/kit/data/data-table.js";
import { Text } from "../../src/kit/values.js";

describe("hierarchy defaults", () => {
  it("sizes a heading above body text", () => {
    const { container } = render(
      <>
        <Text text="Spending dashboard" variant="heading" />
        <Text text="body" />
      </>,
    );
    const heading = screen.getByRole("heading", { name: "Spending dashboard" });
    const body = container.querySelector('[data-variant="body"]') as HTMLElement;
    expect(heading.style.fontSize).not.toBe(body.style.fontSize);
    expect(heading.style.fontSize).toContain("calc(");
  });
});

describe("one-line rows", () => {
  const rows = [
    { to: "Ana", amountCents: 500, date: "2026-07-24" },
    {
      to: "Pacific Northwest Sustainable Grain and Milling Cooperative Association",
      amountCents: 128400,
      date: "2026-08-01",
    },
  ];
  const columns = [
    { key: "to", label: "To" },
    { key: "amountCents", label: "Amount", format: "money" as const, align: "end" as const },
    { key: "date", label: "Date", format: "date" as const },
  ];

  it("never wraps a body cell", () => {
    render(<DataTable rows={rows} columns={columns} />);
    const cells = screen.getAllByRole("row").slice(1).flatMap((r) => within(r).getAllByRole("cell"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.style.whiteSpace).toBe("nowrap");
  });

  it("ellipsizes an overlong value and keeps its full text in the tooltip", () => {
    render(<DataTable rows={rows} columns={columns} />);
    const long = screen.getByTitle(rows[1]!.to);
    // The width cap itself is a `min(…ch, …cqw)`, which only a real browser
    // resolves — it is measured there, not here.
    expect(long.style.textOverflow).toBe("ellipsis");
    expect(long.style.overflow).toBe("hidden");
    // A short value carries no tooltip — a title on every cell is noise.
    expect(screen.queryByTitle("Ana")).toBeNull();
  });

  it("leaves a right-aligned cell unclamped so the amount stays on its edge", () => {
    render(<DataTable rows={rows} columns={columns} />);
    const row = screen.getByText("$1,284.00").closest("tr")!;
    const [to, amount] = within(row).getAllByRole("cell");
    // The clamp is a block that stops filling a wide column; on a right-aligned
    // amount that walks it away from the edge its own header sits on.
    expect(amount!.querySelector("span")).toBeNull();
    expect(to!.querySelector("span")).not.toBeNull();
  });
});
