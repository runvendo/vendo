/**
 * The two promises the contract makes about the page, held against what the
 * shooter actually does.
 *
 * `HARNESS_CONTRACT` is the one text every page-writing contender is graded
 * against, so a sentence in it that the harness does not enforce is a rule
 * everyone is measured on and nobody is held to. Two of them were exactly that:
 * "opened with NO network at all" while nothing intercepted a request, and "shot
 * at 480x900, and what a person sees there is all anyone sees" while the shot was
 * `fullPage`. A contender that reached for a CDN font got it on one laptop and
 * not another, and the judge was shown a screen no person was ever shown.
 *
 * A real browser, because both claims are about what Chromium did.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HARNESS_CONTRACT, openBrowser, type Shooter } from "../src/render.js";

let shooter: Shooter;
beforeAll(async () => {
  shooter = await openBrowser();
}, 60_000);
afterAll(async () => await shooter.close());

/** A page that reaches out. It records what came back on itself, so the test
 *  reads the page's own account of the request rather than the harness's.
 *
 *  `no-cors`, because a same-origin policy refusal is not a network refusal: a
 *  plain `fetch` to another origin from a `setContent` page rejects on CORS
 *  whether or not anything was blocked, so the page would say "refused" on an
 *  unguarded harness too and the test would pin nothing. An opaque request
 *  really does leave the machine, and really does resolve, unless it is
 *  aborted. */
const REACHES_OUT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>remote</title></head>
<body><p id="fetched">not asked yet</p>
<script>
  fetch("https://example.com/rates.json", { mode: "no-cors" })
    .then(function () { document.getElementById("fetched").textContent = "the network answered"; })
    .catch(function () { document.getElementById("fetched").textContent = "the network was refused"; })
    .finally(function () { window.__settled = true; });
</script>
</body></html>`;

/** Taller than the viewport by a long way: the difference between the promised
 *  frame and the whole document is the whole point. */
const TALLER_THAN_THE_FRAME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>tall</title>
<style>body{margin:0}div{height:400px}</style></head>
<body>${"<div>a screenful</div>".repeat(8)}
<script>window.__settled = true;</script>
</body></html>`;

describe("the page has no network", () => {
  it("refuses a remote request instead of letting it resolve", async () => {
    const visit = await shooter.visit(REACHES_OUT);
    try {
      const { visibleText } = await visit.shot();
      expect(visibleText).toContain("the network was refused");
      expect(visibleText).not.toContain("the network answered");
    } finally {
      await visit.close();
    }
  }, 60_000);
});

describe("the shot is the frame the contract names", () => {
  it("is the viewport, not the whole document, however far the page runs on", async () => {
    const visit = await shooter.visit(TALLER_THAN_THE_FRAME);
    try {
      const { png } = await visit.shot();
      // PNG's IHDR: width and height are big-endian 32-bit at bytes 16 and 20.
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({ width: 480, height: 900 });
      // The document really is taller, so a full-page shot would have been 3200.
      const scrolled = await visit.page.evaluate(() => document.body.scrollHeight);
      expect(scrolled).toBeGreaterThan(900);
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("says the size it shoots at, and says the settle the harness really applies", () => {
    expect(HARNESS_CONTRACT).toContain("shot at 480x900");
    // The harness sets `__settled` two frames after load on an authored page
    // whatever the page does, so asking a contender to set it was a rule that
    // could not be broken and could not be kept.
    expect(HARNESS_CONTRACT).toContain("settled two frames after the page loads");
    expect(HARNESS_CONTRACT).not.toContain("window.__settled = true");
  });
});
