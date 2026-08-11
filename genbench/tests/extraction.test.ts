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
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, honestData, NUMBER } from "../src/floor.js";
import { authoredPage, openBrowser, type Shooter, type Shot } from "../src/render.js";
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
