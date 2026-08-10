/**
 * The extraction's token boundaries.
 *
 * The floor reads one string per screen and counts the numbers in it, so where
 * that string puts its boundaries decides what a number IS. Two sibling inline
 * elements — "Housing $2850.00" beside "67%" — sit on one line with no
 * separator between their boxes, and the page's own `innerText` hands back
 * `$2850.0067%`: a token no screen ever printed, which the floor then reports
 * as a fabricated number and tier 2 is asked to derive. The honest percentage
 * never reaches the auditor at all, because it was never a token.
 *
 * Sibling values escaped only by rounding luck — "$612.45" beside "14" fuses to
 * 612.4514, which rounds back onto 612.45 and passes.
 *
 * So this pins the pair: siblings never fuse, and a number written inside ONE
 * text node is never cut apart. A real browser and the real extraction — a
 * double would only prove what a double was told.
 *
 * A shot's other half is the IMAGE, and it has a boundary of its own: the
 * judge's model refuses an image past 8000px on an edge, which failed the
 * tallest screens on transport rather than on the rubric. The second block
 * pins both sides of the fix — the judge's copy fits, and the run folder's
 * copy is untouched — and it lives here because it needs the same thing the
 * first one does: a real browser and a real shot.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, honestData, NUMBER } from "../src/floor.js";
import { authoredPage, openBrowser, pngSize, type Shooter, type Shot } from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let shooter: Shooter;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  shooter = await openBrowser();
}, 120_000);
afterAll(async () => await shooter.close());

/** Whatever the contender wrote, shot the way a run shoots it. */
async function seen(body: string): Promise<Shot> {
  const html = `<!doctype html><html lang="en"><body>${body}</body></html>`;
  const visit = await shooter.visit(authoredPage(html, world, "diy-sonnet"), { authored: true });
  try {
    return await visit.shot();
  } finally {
    await visit.close();
  }
}

/** The numbers the floor will count, in the floor's own words. */
const tokens = (text: string): string[] => [...text.matchAll(NUMBER)].map((match) => match[0]);

describe("visible-text extraction", () => {
  it("keeps two sibling inline elements' numbers apart", async () => {
    // The live case, verbatim: housing's amount and its share of the month.
    const shot = await seen(`<div><span>Housing $2850.00</span><span>67%</span></div>`);

    expect(shot.visibleText).not.toContain("$2850.0067");
    expect(tokens(shot.visibleText)).toEqual(["$2850.00", "67"]);

    // …and so the floor never invents an offender out of the seam between them.
    const result = honestData(shot.visibleText, buildIndex(world));
    const flagged = result.offenders.map((offender) => offender.text);
    expect(flagged).not.toContain("$2850.0067");
    // The amount is housing's own, in dollars — tier 1 clears it, as it always
    // should have. What is left for tier 2 is the percentage, on its own.
    expect(flagged).toEqual(["67"]);
  }, 120_000);

  it("leaves a number written in one text node whole", async () => {
    // The month's total, grouped the way a screen writes it. A separator
    // anywhere inside this would read as "1", "243" and "11".
    const shot = await seen(`<p>Total spent $4,243.11 this month</p>`);

    expect(shot.visibleText).toContain("$4,243.11");
    expect(tokens(shot.visibleText)).toEqual(["$4,243.11"]);
    expect(honestData(shot.visibleText, buildIndex(world)).pass).toBe(true);
  }, 120_000);
});

/** The provider's own limit, spelled here rather than imported: it is a fact
 *  about someone else's API, and a test that read the harness's constant would
 *  agree with whatever the harness happened to believe. */
const MODEL_MAX_PX = 8000;

describe("the judge's evidence", () => {
  it("shrinks a screen too tall to send, and keeps the full-resolution shot whole", async () => {
    // Past the limit the way the densest column's screens are (~8770px) and the
    // baselines' are not (~5200-5760) — which is what made the rejection a bias
    // rather than one bad case.
    const shot = await seen(`<div style="height:9000px">a very tall screen</div>`);

    const full = pngSize(shot.png);
    expect(full.height).toBeGreaterThan(MODEL_MAX_PX);

    const sent = pngSize(shot.evidence);
    expect(Math.max(sent.width, sent.height)).toBeLessThanOrEqual(MODEL_MAX_PX);
    // Scaled, not cropped: the judge grades the screen that was drawn.
    expect(sent.width / sent.height).toBeCloseTo(full.width / full.height, 2);
    // And the copy the run folder keeps is still the one a person can read.
    expect(shot.png).not.toEqual(shot.evidence);
  }, 120_000);

  it("sends a screen that already fits exactly as it was shot", async () => {
    const shot = await seen(`<p>Total spent $4,243.11 this month</p>`);

    expect(pngSize(shot.png).height).toBeLessThanOrEqual(MODEL_MAX_PX);
    // The same buffer, not a re-encode of it: a shot that fits is never touched.
    expect(shot.evidence).toBe(shot.png);
  }, 120_000);
});
