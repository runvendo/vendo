// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card, Grid, Row, Stack, Surface } from "../../src/kit/layout.js";
import { Stat } from "../../src/kit/data/stat.js";

/**
 * Spacing is the theme's, not the writer's. The blind design judge reads one
 * line as "equal padding on all four sides of a card, the same gap between
 * rows"; a per-instance `gap={4}` next to a `gap={16}` on the same screen is
 * what fails it. The prop is still accepted (saved apps and wire trees carry
 * it) — it just cannot win. Markup, not jsdom: the assertion is about the
 * `var()` token that ships, which a CSS parser would normalize away.
 */
const GAP = "gap:var(--vendo-density-card-padding";
const PAD = "padding:var(--vendo-density-card-padding";

describe("Kit spacing comes from the theme scale", () => {
  it("ignores a writer's gap on every layout container", () => {
    const cases = [
      <Stack gap={4} key="s">x</Stack>,
      <Row gap={24} key="r">x</Row>,
      <Grid columns={2} gap={12} key="g">x</Grid>,
    ];
    for (const element of cases) {
      const markup = renderToStaticMarkup(element);
      expect(markup, markup).toContain(GAP);
      expect(markup, markup).not.toMatch(/gap:\d+px/);
    }
  });

  it("pads a card-like surface equally on all four sides, from one token", () => {
    for (const element of [
      <Card title="A" key="c">a</Card>,
      <Surface title="B" key="u">b</Surface>,
      <Stat label="C" value={100} format="money" key="t" />,
    ]) {
      const markup = renderToStaticMarkup(element);
      expect(markup, markup).toContain(PAD);
    }
  });
});
