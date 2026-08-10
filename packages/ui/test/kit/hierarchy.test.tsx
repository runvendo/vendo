// @vitest-environment jsdom
/**
 * The two things a generated screen cannot be asked to remember: the accent is
 * spent on the primary action ONLY, and one thing on the screen is the largest.
 * Both are Kit DEFAULTS, because a model in a hurry forgets a paragraph in a
 * 47k-character brief but cannot forget what a component does when told nothing.
 *
 * Assertions read the serialized `style` ATTRIBUTE, not the shorthand getters:
 * jsdom keeps a `var()` value in the attribute but does not reconstruct every
 * shorthand from it (the precedent is `mcp-http-open-card.test.tsx`).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Grid, Row, Stack } from "../../src/kit/layout.js";
import { Stat } from "../../src/kit/data/stat.js";
import { Callout } from "../../src/kit/feedback/callout.js";
import { Text } from "../../src/kit/values.js";
import { Button } from "../../src/kit/forms/button.js";
import { chartSeries } from "../../src/kit/tokens.js";

/** The host's accent token. Nothing asserted below also uses `accent-text`. */
const ACCENT = "--vendo-color-accent";

const styleOf = (el: Element | null): string => el?.getAttribute("style") ?? "";
const scaleOf = (el: Element | null): string =>
  (el as HTMLElement | null)?.style.getPropertyValue("--vendo-stat-scale") ?? "";

describe("the accent is not the default paint", () => {
  it("charts carry a neutral ramp — a chart is data, not the primary action", () => {
    expect(chartSeries.length).toBeGreaterThan(1);
    for (const color of chartSeries) expect(color).not.toContain(ACCENT);
  });

  it("an untoned Callout is neutral; tone=accent is how a notice asks for the brand", () => {
    const { container } = render(<Callout title="Heads up">Nothing to show yet.</Callout>);
    const plain = container.querySelector('[data-kit="Callout"]');
    expect(plain?.getAttribute("data-tone")).toBe("info");
    expect(styleOf(plain)).not.toContain(ACCENT);

    const toned = render(<Callout tone="accent" title="Note">Highlighted.</Callout>);
    expect(styleOf(toned.container.querySelector('[data-kit="Callout"]'))).toContain(ACCENT);
  });

  it("an untoned Stat's edge is the border color, so a toned one can stand out", () => {
    const plain = render(<Stat label="Balance" value={125000} format="money" />);
    expect(styleOf(plain.container.firstElementChild)).not.toContain(ACCENT);

    const toned = render(<Stat label="Balance" value={125000} format="money" tone="accent" />);
    expect(styleOf(toned.container.firstElementChild)).toContain(ACCENT);
  });

  it("the primary button keeps it", () => {
    render(<Button label="Send transfer" />);
    expect(styleOf(screen.getByRole("button"))).toContain(ACCENT);
  });
});

describe("one thing leads", () => {
  it("a heading is a step up the scale, not bold body text", () => {
    const { container } = render(
      <Stack>
        <Text text="Net worth" variant="heading" />
        <Text text="across every account" />
      </Stack>,
    );
    const heading = styleOf(container.querySelector('[data-variant="heading"]'));
    expect(heading).toContain("1.35");
    expect(heading).not.toBe(styleOf(container.querySelector('[data-variant="body"]')));
  });

  it("a Stat that owns its row reports the answer at the hero size", () => {
    const { container } = render(
      <Stack>
        <Stat label="Total across all accounts" value={3626515} format="money" />
      </Stack>,
    );
    // No container overrode the share, so the tile keeps the hero fallback.
    expect(styleOf(container.querySelector('[data-kit="Stat"] strong'))).toContain("--vendo-stat-scale");
  });

  it("tiles sharing a row shrink to their share of it — a Stat clips, it never wraps", () => {
    const three = render(
      <Grid columns={3}>
        <Stat label="Spent" value={4243} format="money" />
        <Stat label="Largest" value={2850} format="money" />
        <Stat label="Balance" value={3626515} format="money" />
      </Grid>,
    );
    expect(scaleOf(three.container.firstElementChild)).toBe("1.6");

    const pair = render(
      <Row>
        <Stat label="Spent" value={4243} format="money" />
        <Stat label="Balance" value={3626515} format="money" />
      </Row>,
    );
    expect(scaleOf(pair.container.firstElementChild)).toBe("1.9");
  });

  it("a lone child keeps the row whatever the container's column count says", () => {
    const { container } = render(
      <Grid columns={3}>
        <Stat label="Total" value={3626515} format="money" />
      </Grid>,
    );
    expect(scaleOf(container.firstElementChild)).toBe("2.2");
  });

  it("a long value and a placeholder decline the hero size rather than clip", () => {
    const long = render(<Stat label="Notional" value={281413500000} format="money" />);
    expect(styleOf(long.container.querySelector('[data-kit="Stat"] strong'))).not.toContain("--vendo-stat-scale");

    const none = render(<Stat label="Bank" value="" />);
    expect(styleOf(none.container.querySelector('[data-kit="Stat"] strong'))).not.toContain("--vendo-stat-scale");
  });
});
