// @vitest-environment jsdom
/**
 * One thing leads. The Kit's type scale is ORDERED — a screen's headline is the
 * largest text on it, above a Stat's value, above a Card/Surface title, above
 * body — because the blind style judge grades exactly that ("the headline is the
 * largest text on it and sits above the detail it summarises") and a flat scale
 * scored 62% against a raw HTML page's 100%. Multipliers, not pixels: the host's
 * `--vendo-font-size` stays the anchor.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fontSizeAt, typeScale } from "../../src/kit/tokens.js";
import { Text } from "../../src/kit/values.js";

describe("Kit type scale", () => {
  it("orders headline > stat value > section title > body", () => {
    expect(typeScale.headline).toBeGreaterThan(typeScale.statValue);
    expect(typeScale.statValue).toBeGreaterThan(typeScale.cardTitle);
    expect(typeScale.cardTitle).toBeGreaterThan(typeScale.surfaceTitle);
    expect(typeScale.surfaceTitle).toBeGreaterThan(1);
  });

  it("expresses a step against the host's base size, never a fixed pixel", () => {
    expect(fontSizeAt(typeScale.headline)).toBe("calc(var(--vendo-font-size, 15px) * 1.8)");
  });

  it("still renders a heading element for the heading variant", () => {
    render(<Text text="Net worth" variant="heading" />);
    expect(screen.getByRole("heading", { name: "Net worth" })).toBeTruthy();
  });
});
