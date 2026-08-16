/**
 * What the shooter really does with a page: the two promises the contract makes
 * about it, and the DOM it hands the judge.
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
import { MockLanguageModelV3 } from "ai/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import { authoredPage, HARNESS_CONTRACT, openBrowser, type Shooter } from "../src/render.js";
import { loadWorld } from "../src/world.js";

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

// --------------------------------------------- what the judge is given to read

/**
 * A page that carries a runtime inside it, which is what the product's own page
 * IS: a root, the case's data, and the whole renderer bundled in beside them.
 */
const INLINES_A_RUNTIME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>spending</title>
<style>h1{font-size:20px}</style></head>
<body><h1>Spending this month</h1>
<button onclick="window.vendo.callTool('cancel_transfer', { id: 'tr_1' })">Cancel transfer</button>
<script>window.__runtime = ${JSON.stringify("compiled".repeat(125_000))};</script>
</body></html>`;

/** A judge that answers the one line it is asked. Nothing reaches a provider:
 *  the claim is about what the judge is SENT, not about what it says back. */
const answering = (): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ verdicts: [{ verdict: "pass", note: "a header" }] }) }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    }),
  });

/**
 * The SOURCE the judge grades on is the settled DOM, and never the page file.
 *
 * Every column is sent the same channel so the artifact's format cannot classify
 * it — but the FILE could not be that channel, because the page the product
 * renders inlines its whole runtime. The live run said so: `prompt is too long:
 * 1791560 tokens > 1000000 maximum`, on every one of that column's cases, while
 * the baselines' hand-written pages were graded normally. What the browser holds
 * once the screen has settled is the same format for everyone, is small because
 * the script bodies have already run, and is better evidence besides — it is
 * what painted, not what was meant.
 */
describe("the source the judge is given", () => {
  it("is the settled DOM, so a page that inlines a runtime is still small and script-free", async () => {
    const world = await loadWorld(join(dirname(dirname(fileURLToPath(import.meta.url))), "worlds", "maple"));
    const html = authoredPage(INLINES_A_RUNTIME, world, "vendo-sonnet");
    const visit = await shooter.visit(html);
    try {
      const { dom, png } = await visit.shot();

      expect(dom).toContain("Spending this month");
      expect(dom).not.toContain("<script");
      expect(dom.length).toBeLessThan(html.length / 10);

      // Through the real judge, because the whole failure was in the prompt it
      // assembles rather than in anything it answered.
      const model = answering();
      await judge(
        {
          screenshot: png,
          artifact: dom,
          trace: [],
          caseLines: ["shows the month's spending"],
          styleLines: [],
          caseHash: "settled-dom",
        },
        { model },
      );
      const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);

      expect(sent).toContain("Spending this month");
      expect(sent).not.toContain("window.__runtime");
      // And the name is still struck out of it: the DOM says who wrote the page
      // in every handler on it, which is the tell blinding exists to take.
      expect(sent).toContain("host.callTool");
    } finally {
      await visit.close();
    }
  }, 60_000);
});
