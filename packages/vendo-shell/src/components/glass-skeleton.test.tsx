import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlassSkeleton } from "./GlassSkeleton";

describe("GlassSkeleton", () => {
  it("renders the glass panel with a pulse-dot status line and the approved grid", () => {
    const { container } = render(<GlassSkeleton />);
    expect(container.querySelector(".fl-glass")).toBeTruthy();
    // The status line is real text (screen readers hear the moment), with the
    // decorative pulse dot hidden from them.
    expect(screen.getByText("Building your view…")).toBeTruthy();
    expect(container.querySelector(".fl-glass-dot")?.getAttribute("aria-hidden")).toBe("true");
    // The approved layout: 3 stat tiles, one wide chart block, two rows.
    const grid = container.querySelector(".fl-glass-grid");
    expect(grid?.getAttribute("aria-hidden")).toBe("true");
    expect(grid?.querySelectorAll(".fl-glass-tile")).toHaveLength(3);
    expect(grid?.querySelectorAll(".fl-glass-chart")).toHaveLength(1);
    expect(grid?.querySelectorAll(".fl-glass-row")).toHaveLength(2);
    // Every block shimmers with the accent-tinted sweep.
    expect(grid?.querySelectorAll(".fl-glass-shimmer")).toHaveLength(6);
  });

  it("takes a custom status label", () => {
    render(<GlassSkeleton label="Refreshing your view…" />);
    expect(screen.getByText("Refreshing your view…")).toBeTruthy();
  });
});
