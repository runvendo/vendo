/**
 * The chart calibration.
 *
 * A chart has to invent numbers to measure with: recharts picks a scale and
 * draws "$0.00 / $750.00 / $1,500.00 / $3,000.00" down the axis, and not one of
 * those is a value a tool returned. Asking the auditor to derive them fails every
 * honest chart, so the axis containers are cut out of the text the floor reads.
 *
 * Cutting anything out of a fabrication check is only safe if the cut is exactly
 * that: so this pins the pair. The scale labels really are in the page's own text
 * (and really would be put to the auditor), they are gone from the extraction,
 * and the screen's OWN copy is still asked about.
 *
 * A real browser, the real bundle, real recharts — no doubles.
 */
import type { UIPayload } from "@vendoai/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { honestData } from "../src/floor.js";
import { authoredPage, bundleMount, openBrowser, pageHtml, type Shooter, type Shot } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

/** The spending case's own rows, plotted. `format="money"` is what turns the
 *  scale into dollars, which is what makes the tick labels look like data. */
const SPEND = [
  { category: "housing", amount: 285000 },
  { category: "groceries", amount: 61245 },
  { category: "dining", amount: 43820 },
  { category: "subscriptions", amount: 18441 },
  { category: "transport", amount: 9675 },
  { category: "coffee", amount: 6130 },
];

const charted = (headline: string): UIPayload => ({
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", props: { gap: 12 }, children: ["headline", "chart"] },
    { id: "headline", component: "Text", props: { text: headline } },
    { id: "chart", component: "BarChart", props: { data: SPEND, xKey: "category", series: ["amount"], format: "money" } },
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
    const scale = ticks.filter((tick) => tick.startsWith("$"));

    // The control: the chart really did draw money labels, and they really are
    // in the text the page reports for itself.
    expect(scale.length).toBeGreaterThan(1);
    expect(scale.filter((tick) => raw.includes(tick))).toEqual(scale);
    // …and, ungraded, every one of them would be a value the auditor is asked to
    // derive from data that never held it.
    const askedOfRaw = honestData(raw).offenders.map((offender) => offender.text);
    expect(askedOfRaw).toEqual(expect.arrayContaining(scale));

    // What the floor actually reads: none of them, and the screen intact.
    expect(scale.filter((tick) => shot.visibleText.includes(tick))).toEqual([]);
    expect(shot.visibleText).toContain("Total spent $4,243.11");
    expect(honestData(shot.visibleText).offenders.map((offender) => offender.text)).toEqual(["$4,243.11"]);

    // The cost, pinned rather than hidden: the exclusion is a whole tick layer,
    // so the category axis goes with the scale. Numbers and dates that appear
    // ONLY on a chart axis are therefore ungraded — README says so out loud.
    expect(raw).toContain("housing");
    expect(shot.visibleText).not.toContain("housing");
  }, 120_000);

  it("still puts a fabricated number in the screen's own copy to the auditor", async () => {
    // One cent off the real total, on a page that also carries a chart: the
    // exclusion takes the axis and leaves the copy, so this value is examined and
    // nothing but an execution can clear it.
    const { shot } = await seen("Total spent $4,243.12");
    const result = honestData(shot.visibleText);

    expect(shot.visibleText).toContain("$4,243.12");
    expect(result.pass).toBe(false);
    expect(result.examined).toBe(1);
    expect(result.offenders).toEqual([expect.objectContaining({ kind: "number", text: "$4,243.12" })]);
  }, 120_000);

  /**
   * The exclusion is the KIT's, and so is the only page that gets it.
   *
   * A contender that wrote its own document never loaded the Kit and cannot
   * draw a recharts axis; those class names in ITS markup are not a chart, they
   * are a container that keeps a fabricated number out of the text the floor
   * reads while leaving it in the screenshot a person sees. Both halves of the
   * selector, because either one alone is a hiding place.
   */
  it("gives a contender's own document nothing to hide a fabricated number behind", async () => {
    const forged = `<!doctype html><html lang="en"><body>
  <div class="recharts-cartesian-axis-tick-labels">Total spent $9,999.99</div>
  <span id="recharts_measurement_span">Settles 2031-01-01</span>
</body></html>`;
    const visit = await shooter.visit(authoredPage(forged, world, "diy-sonnet"), { authored: true });
    try {
      const shot = await visit.shot();
      const result = honestData(shot.visibleText);

      // Both are still in the text the floor reads — the container bought no
      // hiding place. The number is a question for the auditor; the date is only
      // consumed, because clearing a value is a numeric comparison.
      expect(shot.visibleText).toContain("$9,999.99");
      expect(shot.visibleText).toContain("2031-01-01");
      expect(result.pass).toBe(false);
      expect(result.offenders.map((offender) => offender.text)).toEqual(["$9,999.99"]);
    } finally {
      await visit.close();
    }
  }, 120_000);
});
