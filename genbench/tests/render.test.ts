/**
 * What the shooter really does with a page: the two promises the contract makes
 * about it, and the DOM it hands the judge.
 *
 * `HARNESS_CONTRACT` is the one text every page-writing contender is graded
 * against, so a sentence in it that the harness does not enforce is a rule
 * everyone is measured on and nobody is held to. Two of them were exactly that:
 * "opened with NO network at all" while nothing intercepted a request, and "shot
 * at 1280x900, and what a person sees there is all anyone sees" while the shot was
 * `fullPage`. A contender that reached for a CDN font got it on one laptop and
 * not another, and the judge was shown a screen no person was ever shown.
 *
 * A real browser, because both claims are about what Chromium did.
 */
import type { UIPayload } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import { mutateSeam } from "../src/liveness.js";
import {
  authoredPage,
  bundleMount,
  HARNESS_CONTRACT,
  openBrowser,
  pageHtml,
  worldToday,
  type Shooter,
} from "../src/render.js";
import { loadWorld, type World } from "../src/world.js";

let shooter: Shooter;
beforeAll(async () => {
  shooter = await openBrowser();
}, 60_000);
afterAll(async () => await shooter.close());

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worldNamed = async (name: string): Promise<World> => await loadWorld(join(root, "worlds", name));

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
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({ width: 1280, height: 900 });
      // The document really is taller, so a full-page shot would have been 3200.
      const scrolled = await visit.page.evaluate(() => document.body.scrollHeight);
      expect(scrolled).toBeGreaterThan(900);
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("says the size it shoots at, and says the settle the harness really applies", () => {
    expect(HARNESS_CONTRACT).toContain("shot at 1280x900");
    // The harness sets `__settled` two frames after load on an authored page
    // whatever the page does, so asking a contender to set it was a rule that
    // could not be broken and could not be kept.
    expect(HARNESS_CONTRACT).toContain("settled two frames after the page loads");
    expect(HARNESS_CONTRACT).not.toContain("window.__settled = true");
  });
});

// ------------------------------------------------- the clock the page is on

/** A page that says which zone it was painted in, and renders one of the Z
 *  timestamps a world really answers with. */
const TELLS_THE_TIME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>clock</title></head>
<body><p id="zone"></p><p id="sent"></p>
<script>
  document.getElementById("zone").textContent = "zone " + Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById("sent").textContent = "sent " + new Date("2026-08-10T08:12:00Z")
    .toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  window.__settled = true;
</script>
</body></html>`;

/** A page that does the arithmetic every "5 days ago" on every screen does: what
 *  the browser thinks today is, minus a date a tool answered with. `authoredPage`
 *  sets the settle itself, so nothing here has to.
 *
 *  `id="today"` on purpose: the harness writes the world's day into the page
 *  under a PREFIXED id, and a page's own plain `today` must still be its own. */
const COUNTS_THE_DAYS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ago</title></head>
<body><p id="today"></p><p id="ago"></p>
<script>
  var now = new Date();
  document.getElementById("today").textContent = "today " + now.toISOString().slice(0, 10);
  document.getElementById("ago").textContent =
    Math.round((now - new Date("2026-08-01T00:00:00Z")) / 86400000) + " days ago";
</script>
</body></html>`;

/**
 * The screens are graded against tool data written in Z, so they have to be
 * PAINTED in Z — and on the day the world says it is, not the day the operator
 * happens to run the benchmark.
 *
 * Both halves were live failures, on both columns, charged to the contenders:
 * `support-desk/ticket-detail` was failed for "message timestamps like 'Aug 10,
 * 1:12 AM' do not correspond to any tool value (08:12Z)" — exactly the seven
 * hours between the world and a Pacific laptop — and
 * `support-desk/duplicate-merge` for calling 2026-08-12 "5 days ago" while
 * calling the older 2026-08-10 "last week", which is what arithmetic against a
 * wall clock five days past the world's newest datum produces.
 */
describe("the page is painted on the world's clock", () => {
  it("renders a Z timestamp as the world wrote it, not shifted into the operator's zone", async () => {
    const visit = await shooter.visit(TELLS_THE_TIME);
    try {
      const { visibleText } = await visit.shot();
      expect(visibleText).toContain("zone UTC");
      expect(visibleText).toContain("sent 08:12");
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("believes it is the day the world says it is, however long ago the run was recorded", async () => {
    const world = await worldNamed("maple");
    // maple's own tool descriptions say "Today is 2026-08-11", and that is the
    // whole claim: this expectation is a constant, so it can only pass because
    // the clock came from the world and never from the calendar.
    expect(worldToday(world)).toBe("2026-08-11T00:00:00.000Z");
    const page = authoredPage(COUNTS_THE_DAYS, world, "diy-sonnet");
    const visit = await shooter.visit(page);
    try {
      const { visibleText } = await visit.shot();
      expect(visibleText).toContain("today 2026-08-11");
      expect(visibleText).toContain("10 days ago");
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("is the same clock when liveness paints the page again with the data moved", async () => {
    const world = await worldNamed("maple");
    const { html, moved } = mutateSeam(authoredPage(COUNTS_THE_DAYS, world, "diy-sonnet"));
    // The mutation really did move something, so the repaint below is the one
    // liveness takes and not a page it left alone.
    expect(moved.length).toBeGreaterThan(0);
    const visit = await shooter.visit(html);
    try {
      const { visibleText } = await visit.shot();
      expect(visibleText).toContain("today 2026-08-11");
      expect(visibleText).toContain("10 days ago");
    } finally {
      await visit.close();
    }
  }, 60_000);
});

/**
 * Where that day comes from. A world's own word beats its newest row, because
 * rows carry the future as readily as the past — `property-management` holds
 * leases running to 2027-05-31 and states "today is Aug 12 2026", and taking the
 * newest row plus a day would paint every one of its screens ten months late,
 * with every active lease expired.
 */
describe("the day a world is looked at on", () => {
  it("is what the world SAYS, not the last date in its rows", async () => {
    expect(worldToday(await worldNamed("property-management"))).toBe("2026-08-12T00:00:00.000Z");
    // The hour too, where the world names one — and in every spelling `worlds/`
    // uses: "Today is 2026-08-12 and it is about 14:22", and support-desk's
    // "`sla_minutes_remaining` is measured from now, 2026-08-12T15:10:00Z".
    expect(worldToday(await worldNamed("observability"))).toBe("2026-08-12T14:22:00.000Z");
    expect(worldToday(await worldNamed("support-desk"))).toBe("2026-08-12T15:10:00.000Z");
  });

  it("falls back to the newest row plus a day where a world says nothing", async () => {
    // product-analytics states no today; its newest datum is 2026-08-11T06:41Z.
    expect(worldToday(await worldNamed("product-analytics"))).toBe("2026-08-12T06:41:00.000Z");
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
      content: [
        { type: "text" as const, text: JSON.stringify({ verdicts: [{ line: 1, verdict: "pass", note: "a header" }] }) },
      ],
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
          toolData: "",
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

// ------------------------------------------ what scrolling sideways reveals

/**
 * A table wider than the graded frame keeps its right-hand columns past the
 * horizontal fold — where a person reaches them by scrolling and the judge,
 * grading the viewport shot, could not reach them at all. Three style lines were
 * failed on conventions that were on the screen the whole time.
 *
 * So the fold gets its own picture. The claim is about what Chromium hands over,
 * so these run in a real browser, and the first one goes through the KIT's own
 * table — every column renders at the width its content asks for and the wrapper
 * scrolls (`data-table.tsx`), which is the shape that lost those lines.
 *
 * THIRTEEN columns, because the frame is a 1280px desktop panel now (`VIEWPORT`
 * in `render.ts`) and the six that overflowed a 480px phone column fit inside it
 * with room to spare. That is the whole point of the widening — most screens stop
 * needing this picture — but the mechanism still has to work for the screens that
 * do, so the fixture is sized to overflow the frame it is actually shot in. A
 * fixture that merely fits would leave these tests green and prove nothing.
 */
const TABLE_ROWS = [
  { reference: "INV-2026-0148", client: "Northwind Traders", opened: "2026-08-04", due: "2026-09-03", assignee: "Priya Raman", approver: "Lena Fairbanks", region: "EMEA — Benelux", po: "PO-88421", terms: "net 30", contact: "ada.blum@northwind.example", project: "Q3 fit-out, phase 2", status: "awaiting review", amount: "$12,480.00" },
  { reference: "INV-2026-0149", client: "Fabrikam Logistics", opened: "2026-08-06", due: "2026-09-20", assignee: "Daniel Osei", approver: "Lena Fairbanks", region: "AMER — Midwest", po: "PO-88437", terms: "net 45", contact: "r.calder@fabrikam.example", project: "Depot relocation", status: "sent to client", amount: "$3,905.50" },
  { reference: "INV-2026-0151", client: "Contoso Interiors", opened: "2026-08-09", due: "2026-08-24", assignee: "Mariana Silva", approver: "Tomas Weber", region: "APAC — Queensland", po: "PO-88502", terms: "net 15", contact: "j.hale@contoso.example", project: "Showroom refresh", status: "overdue", amount: "$18,220.75" },
];

const KIT_WIDE_TABLE: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    {
      id: "root",
      component: "DataTable",
      // Every key the rows carry, in their own order: a column list that drifted
      // from the rows would narrow the table and quietly stop testing the fold.
      props: { rows: TABLE_ROWS, columns: Object.keys(TABLE_ROWS[0]!) },
    },
  ],
} as UIPayload;

/** The same shape a contender writes by hand: a table too wide for the frame,
 *  inside the `overflow-x:auto` wrapper every hand-written one uses. */
const HAND_WIDE_TABLE = (count: number): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>invoices</title>
<style>body{margin:0;padding:20px;font:14px system-ui}
.scroller{overflow-x:auto;border:1px solid #ddd;margin-bottom:16px}
td,th{white-space:nowrap;padding:8px 14px;border-bottom:1px solid #eee}</style></head>
<body>${`<div class="scroller"><table><thead><tr>${Object.keys(TABLE_ROWS[0]!)
  .map((key) => `<th>${key}</th>`)
  .join("")}</tr></thead><tbody>${TABLE_ROWS.map(
  (row) => `<tr>${Object.values(row).map((cell) => `<td>${cell}</td>`).join("")}</tr>`,
).join("")}</tbody></table></div>`.repeat(count)}
<script>window.__settled = true;</script>
</body></html>`;

/** Far wider than any picture is worth: one table that asks for ten times the
 *  cap, inside a scroller that really does scroll. */
const RUNS_OFF_FOREVER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ledger</title>
<style>body{margin:0;padding:20px;font:14px system-ui}
.scroller{overflow-x:auto}
table{width:40000px}
td{white-space:nowrap;padding:8px 14px}</style></head>
<body><div class="scroller"><table><tbody><tr><td>one</td><td>of many</td></tr></tbody></table></div>
<script>window.__settled = true;</script>
</body></html>`;

/**
 * A page that defeats the cap with its own `!important`, and asks for a picture
 * Chromium will not take: a million pixels across and six hundred down.
 *
 * The point is not the CSS trick, it is that SOMETHING will always be
 * uncapturable — the live failure was this exact refusal, reached by a route the
 * cap now closes. A bonus picture that cannot be taken must cost nothing but
 * itself.
 */
const DEFEATS_THE_CAP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>renewals</title>
<style>body{margin:0;padding:20px;font:14px system-ui}
.scroller{overflow-x:auto;max-width:none!important}
table{width:1000000px}
td{white-space:nowrap;padding:8px 14px;height:600px}</style></head>
<body><h1>Upcoming renewals</h1>
<div class="scroller"><table><tbody><tr><td>Northwind</td><td>$12,480.00</td></tr></tbody></table></div>
<script>window.__settled = true;</script>
</body></html>`;

/** A table that FITS: two short columns at the same viewport, so nothing about it
 *  is past any fold and nothing should be shot twice. */
const FITS_IN_THE_FRAME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>totals</title>
<style>body{margin:0;padding:20px;font:14px system-ui}td{padding:8px}</style></head>
<body><table><tbody><tr><td>Open</td><td>3</td></tr><tr><td>Paid</td><td>9</td></tr></tbody></table>
<script>window.__settled = true;</script>
</body></html>`;

/** A PNG's own width, off the IHDR — big-endian 32-bit at byte 16. */
const widthOf = (png: Buffer): number => png.readUInt32BE(16);

/** Every picture the judge was really sent, in order. The SDK hands an image over
 *  as a `file` part whose bytes are either a byte array or base64. */
const pictures = (call: { prompt: unknown }): Buffer[] =>
  (call.prompt as Array<{ content: unknown }>)
    .flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<{ type: string; data?: unknown }>) : [],
    )
    .filter((part) => part.type === "file")
    .map((part) =>
      typeof part.data === "string" ? Buffer.from(part.data, "base64") : Buffer.from(part.data as Uint8Array),
    );

describe("a table that scrolls sideways", () => {
  let bundle: string;
  beforeAll(async () => {
    bundle = await bundleMount();
  }, 120_000);

  it("is shot again at its full width, and the screen is left exactly as it was graded", async () => {
    const world = await worldNamed("maple");
    const visit = await shooter.visit(pageHtml(KIT_WIDE_TABLE, world, bundle, "vendo-sonnet"));
    try {
      const { png, tables } = await visit.shot();

      // The graded shot is untouched: the frame the contract promises, whatever
      // else was captured beside it.
      expect({ width: widthOf(png), height: png.readUInt32BE(20) }).toEqual({ width: 1280, height: 900 });
      // And one extra picture, WIDER than that frame — which it can only be if the
      // columns past the fold are in it.
      expect(tables).toHaveLength(1);
      expect(widthOf(tables[0]!)).toBeGreaterThan(1280);

      // The probe walks this page next, so the expansion has to be undone: a table
      // left at full width is not the screen the shot above was taken of.
      const after = await visit.page.evaluate(() => {
        const scroller = document.querySelector("table")!.parentElement!;
        return {
          marked: document.querySelectorAll("[data-genbench-wide]").length,
          clips: scroller.scrollWidth - scroller.clientWidth > 1,
        };
      });
      expect(after).toEqual({ marked: 0, clips: true });
    } finally {
      await visit.close();
    }
  }, 120_000);

  it("is not shot at all when the table fits, so most screens pay nothing", async () => {
    const visit = await shooter.visit(FITS_IN_THE_FRAME);
    try {
      expect((await visit.shot()).tables).toEqual([]);
    } finally {
      await visit.close();
    }
  }, 60_000);

  /**
   * The screen that proved what believing a rounding artifact costs.
   *
   * `subscription-billing/renewal-schedule` in run 2026-08-18T18-47-44 lost all
   * ELEVEN of its rubric lines to `Unable to capture screenshot`: a 2px artifact
   * on the page's own root Stack read as a fold, the walk climbed past a scroll
   * wrapper that had nothing to scroll and widened the page's layout instead of a
   * table, a `width:100%` `<select>` resolved against the now-indefinite block to
   * Chromium's 1e6px sentinel, and the throw came out of `shot()`. It armed on 45
   * of that run's 54 vendo cases.
   *
   * Replayed through the Kit from that run's own payload, lifted verbatim out of
   * the saved `page.html`: the file itself is 2.9MB, because the page the product
   * renders inlines its whole runtime, and the payload is the same screen at a
   * hundred-and-eightieth of the size — the same trade `honesty.test.ts` makes in
   * checking in figures rather than documents.
   */
  it("is not shot when a page's own layout merely rounds, and the case lives", async () => {
    const payload = JSON.parse(
      await readFile(join(root, "tests", "fixtures", "renewal-schedule-screen.json"), "utf8"),
    ) as UIPayload;
    const world = await worldNamed("subscription-billing");
    const visit = await shooter.visit(pageHtml(payload, world, bundle, "vendo-sonnet"));
    try {
      // The fixture is only worth anything while it is still the defect: nothing
      // that scrolls hides anything, and something out past the tables measures a
      // couple of pixels wide anyway.
      const measured = await visit.page.evaluate(() => {
        const hides = (node: HTMLElement): number => node.scrollWidth - node.clientWidth;
        const ancestry = (table: HTMLElement): HTMLElement[] => {
          const nodes: HTMLElement[] = [];
          for (let node: HTMLElement | null = table; node !== null; node = node.parentElement) nodes.push(node);
          return nodes;
        };
        const tables = [...document.querySelectorAll<HTMLElement>('table, [role="table"]')].map(ancestry);
        return {
          scrollers: tables.flat().filter((node) => /^(auto|scroll)$/.test(getComputedStyle(node).overflowX)).map(hides),
          rounding: tables.flat().map(hides).filter((hidden) => hidden > 0),
        };
      });
      expect(measured.scrollers).not.toEqual([]);
      expect(measured.scrollers.filter((hidden) => hidden > 0)).toEqual([]);
      expect(measured.rounding).not.toEqual([]);
      expect(Math.max(...measured.rounding)).toBeLessThanOrEqual(8);

      const { png, tables } = await visit.shot();

      expect({ width: widthOf(png), height: png.readUInt32BE(20) }).toEqual({ width: 1280, height: 900 });
      expect(tables).toEqual([]);
    } finally {
      await visit.close();
    }
  }, 120_000);

  it("is never shot wider than the cap, however far the table runs on", async () => {
    const visit = await shooter.visit(RUNS_OFF_FOREVER);
    try {
      const { tables } = await visit.shot();

      // The table asks for 40000px. The picture stops where Chromium can still
      // take one, and a judge can still read one.
      expect(tables).toHaveLength(1);
      expect(widthOf(tables[0]!)).toBe(4000);
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("costs the case nothing when Chromium refuses the picture anyway", async () => {
    const visit = await shooter.visit(DEFEATS_THE_CAP);
    try {
      const { png, tables, visibleText } = await visit.shot();

      // The shot really was attempted: this scroller hides most of a million
      // pixels, so an empty `tables` below can only be the refusal, swallowed.
      const hidden = await visit.page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".scroller")!;
        return scroller.scrollWidth - scroller.clientWidth;
      });
      expect(hidden).toBeGreaterThan(8);
      expect(tables).toEqual([]);

      // And the case keeps everything it had: the graded shot and the reading were
      // taken before the bonus was tried, and a refusal cannot reach back for
      // them.
      expect({ width: widthOf(png), height: png.readUInt32BE(20) }).toEqual({ width: 1280, height: 900 });
      expect(visibleText).toContain("Upcoming renewals");

      // The page is still the page the probe walks next, too: the mark and the
      // widths came off even though the shot never happened.
      const after = await visit.page.evaluate(() => ({
        marked: document.querySelectorAll("[data-genbench-wide]").length,
        style: document.querySelector(".scroller")!.getAttribute("style"),
      }));
      expect(after).toEqual({ marked: 0, style: null });
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("is shot at most three times per screen, however many tables run off the edge", async () => {
    const visit = await shooter.visit(HAND_WIDE_TABLE(4));
    try {
      const { tables } = await visit.shot();

      expect(tables).toHaveLength(3);
      for (const table of tables) expect(widthOf(table)).toBeGreaterThan(1280);
    } finally {
      await visit.close();
    }
  }, 60_000);

  it("reaches the judge, right behind the screenshot it belongs to", async () => {
    const world = await worldNamed("maple");
    const visit = await shooter.visit(authoredPage(HAND_WIDE_TABLE(1), world, "diy-sonnet"));
    try {
      const { png, tables, dom } = await visit.shot();
      const model = answering();

      // Through the real judge, because the whole claim is about the prompt it
      // assembles. No lines of its own, so the one standing line is the whole
      // rubric and the double answers it in one call.
      await judge(
        { screenshot: png, tables, artifact: dom, trace: [], toolData: "", caseLines: [], styleLines: [], caseHash: "wide-table" },
        { model },
      );

      expect(pictures(model.doGenerateCalls[0]!)).toEqual([png, tables[0]]);
    } finally {
      await visit.close();
    }
  }, 60_000);
});
