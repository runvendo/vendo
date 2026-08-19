/**
 * The chart calibration.
 *
 * A chart has to invent numbers to measure with: recharts picks a scale and
 * draws "0 / 75,000 / 150,000 / 225,000 / 300,000" down the axis, and not one of
 * those is a value a tool returned, so the axis containers are cut out of the
 * text the harness extracts from a settled screen.
 *
 * Cutting anything out of that text is only safe if the cut is exactly that: so
 * this pins the pair. The scale labels really are in the page's own text, they
 * are gone from the extraction, and the screen's OWN copy survives it.
 *
 * A real browser, the real bundle, real recharts — no doubles.
 */
import type { UIPayload } from "@vendoai/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

/** The spending case's own rows, plotted — cents, the unit the host stores. The
 *  scale recharts picks off them is five-figure, which is what makes the tick
 *  labels look like data. */
const SPEND = [
  { category: "housing", amount: 285000 },
  { category: "groceries", amount: 61245 },
  { category: "dining", amount: 43820 },
  { category: "subscriptions", amount: 18441 },
  { category: "transport", amount: 9675 },
  { category: "coffee", amount: 6130 },
];

/** The screen's own helper, as a generated screen writes one: the Kit formats
 *  nothing, so a chart's figures are the screen's text and the division out of
 *  the host's minor units happens here. */
const money = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const charted = (headline: string): UIPayload => ({
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", props: { gap: 12 }, children: ["headline", "chart"] },
    { id: "headline", component: "Text", props: { text: headline } },
    // The series formatter in its RESOLVED form — one string per row in `data`
    // order, which is what the screen VM hands a component across the wire
    // (`ui/test/tree/kit-passthrough-seam.test.tsx`). It prints on the bars. The
    // value axis is the one place no formatter reaches, so those ticks read as
    // the plotted cents with plain digit grouping and nothing else.
    {
      id: "chart",
      component: "BarChart",
      props: {
        data: SPEND,
        xKey: "category",
        series: [{ key: "amount", format: SPEND.map((row) => money(row.amount)) }],
      },
    },
  ],
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let bundle: string;
let shooter: Shooter;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  bundle = await bundleMount();
  shooter = await openBrowser();
}, 120_000);
afterAll(async () => await shooter.close());

/** The shot the floor grades, and beside it the page's own untouched text —
 *  the control that says the exclusion removed something real. */
async function seen(headline: string): Promise<{ shot: Shot; raw: string; ticks: string[] }> {
  const visit = await shooter.visit(pageHtml(charted(headline), world, bundle, "vendo-sonnet"));
  try {
    const shot = await visit.shot();
    const raw = await visit.page.evaluate(() => document.body.innerText);
    const ticks = await visit.page.evaluate(() =>
      [...document.querySelectorAll(".recharts-cartesian-axis-tick-value")].map((node) => node.textContent ?? ""),
    );
    return { shot, raw, ticks };
  } finally {
    await visit.close();
  }
}

describe("chart axis ticks are measuring marks, not data", () => {
  it("drops the scale labels the chart drew, and only those", async () => {
    const { shot, raw, ticks } = await seen("Total spent $4,243.11");
    // The scale, in the digit grouping the axis falls back to where no formatter
    // reaches (`ui` charts/sanitize.tsx `plainFigure`). The GROUPED ticks are the
    // ones worth looking for: the bare "0" the scale starts at is a substring of
    // the screen's own "$2,850.00", so it would prove nothing either way.
    const scale = ticks.filter((tick) => tick.includes(","));

    // The control: the chart really did draw five-figure labels, and they really
    // are in the text the page reports for itself.
    expect(scale.length).toBeGreaterThan(1);
    expect(scale.filter((tick) => raw.includes(tick))).toEqual(scale);

    // What the extraction actually reads: none of them, and the screen intact.
    expect(scale.filter((tick) => shot.visibleText.includes(tick))).toEqual([]);
    expect(shot.visibleText).toContain("Total spent $4,243.11");

    // The cost, pinned rather than hidden: the exclusion is a whole tick layer,
    // so the category axis goes with the scale. Numbers and dates that appear
    // ONLY on a chart axis are therefore not in the extracted text at all.
    expect(raw).toContain("housing");
    expect(shot.visibleText).not.toContain("housing");
  }, 120_000);

  it("still leaves a fabricated number in the screen's own copy", async () => {
    // One cent off the real total, on a page that also carries a chart: the
    // exclusion takes the axis and leaves the copy.
    const { shot } = await seen("Total spent $4,243.12");

    expect(shot.visibleText).toContain("$4,243.12");
  }, 120_000);

  /**
   * The SAME exclusion on a document the harness did not compile.
   *
   * It was the Kit's alone, on the reasoning that those class names in
   * hand-written markup would be a hiding place rather than a chart. That
   * reasoning graded the harness: a Kit chart's axis was measuring marks and an
   * identical hand-drawn axis was fabrication, so the columns that cannot use the
   * Kit were failed for drawing the same picture. The exclusion is a property of
   * what the text IS, not of who emitted it.
   *
   * The cost is real: a number that appears ONLY on a chart axis is out of the
   * extracted text for everyone, and any contender may put one there — where
   * nobody, its author included, reads it as a claim about the data. The screen's
   * own copy survives, which is the half that matters.
   */
  it("reads a contender's own document by the same rule, ticks out and copy in", async () => {
    const authored = `<!doctype html><html lang="en"><body>
  <p>Total spent $4,243.11</p>
  <div class="recharts-cartesian-axis-tick-labels"><span class="recharts-cartesian-axis-tick-value">$3,000.00</span></div>
  <span id="recharts_measurement_span">Settles 2031-01-01</span>
</body></html>`;
    const visit = await shooter.visit(authoredPage(authored, world, "diy-sonnet"));
    try {
      const shot = await visit.shot();

      // The axis goes, whoever drew it…
      expect(shot.visibleText).not.toContain("$3,000.00");
      expect(shot.visibleText).not.toContain("2031-01-01");
      // …and the screen's own copy is read exactly as it is on a compiled page.
      expect(shot.visibleText).toContain("$4,243.11");
    } finally {
      await visit.close();
    }
  }, 120_000);

});
