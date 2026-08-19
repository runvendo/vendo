import { chromium, type Browser, type Page } from "@playwright/test";
import type { Json, UIPayload } from "@vendoai/core";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cannedResponse, type World } from "./world.js";

/**
 * The frame every screen is graded in: a desktop panel, 1280x900 (2026-08-18).
 *
 * Widened from a 480px phone column, and the HEIGHT did not move — one variable,
 * so a column's score before and after differs by room across and nothing else.
 * The narrow frame was measuring the wrong thing: a desk product's screen is
 * opened on a laptop, and a table that had to scroll sideways in a phone column
 * simply fits here.
 *
 * Exported because this number is the frame TWICE — the size the shot is taken at
 * down in `openBrowser`, and the surface the vendo column hands its own screen
 * agent (`vendo.ts`, read back by `surfaceNote` in `screen-agent.ts` and measured
 * against by the reviewer). Two spellings of it would let a column write for one
 * frame and be graded in another. Every contender is shot at the same size, so the
 * screenshots stack side by side in the report.
 */
export const VIEWPORT = { width: 1280, height: 900 } as const;

/**
 * The mechanical seam every page is scored through, in the ONE wording every
 * contender that writes a page is given.
 *
 * It lives here because this file IS the seam: `seam` installs `window.vendo`,
 * `authoredPage` installs the settle signal, `VIEWPORT` above is the size the
 * shot is taken at, and `probe.ts` reads `[role=dialog]`. A contract kept
 * anywhere else drifts from the code it describes, and a contract kept per
 * contender drifts from the OTHER contender — which is what happened: the
 * `claude-code` column was coached on wiring, confirmations, the settle and the
 * viewport, and `diy` was told none of it, so a column was being graded on what
 * it had been told rather than on what it built. One text, both baselines,
 * pinned byte for byte by `diy.test.ts`.
 *
 * Every sentence here is a rule the harness KEEPS, which is a separate promise
 * from stating it. The honesty rule used to recite the deterministic allowlist —
 * "a sum, count, min, max or mean of one numeric field" — which stopped being
 * true when that allowlist was deleted. The network was promised away and never
 * blocked, the viewport was promised as the frame and the shot was `fullPage`,
 * and the settle signal was asked for and then set by `authoredPage` two frames
 * after load whatever the page did. The first two are now enforced below; the
 * third said the truth instead, because the harness setting it is the better
 * behaviour and only the sentence was wrong.
 */
export const HARNESS_CONTRACT = `THE PAGE — the seam every screen is scored through, the same for whoever writes it.

- SELF-CONTAINED. Inline every style and every script. The page is opened with NO network at all, so a CDN link, a webfont URL or an import of anything paints a blank screen.
- WIRED. Every control a person can press must call \`window.vendo.callTool("<tool name>", { ...arguments })\`, with arguments that tool's input schema accepts. \`window.vendo\` is already on the page before anything you write runs — use it, do not define it.
- CONFIRMED. A step that confirms before acting must carry \`role="dialog"\`. The harness records the text it shows, then presses EACH control inside it once, on a fresh screen each time: the one that goes through must call the tool that does the work, and the one that backs out must not call it.
- FINISHED. The screen is considered settled two frames after the page loads, and it is shot then. Draw synchronously: anything painted later may not be in the picture anyone grades.
- HONEST. Every number and every date on the screen must come from what a tool answered — shown as it is, or computed from it. Nothing above says what any tool answers with, so a screen only knows by asking. Anything else is graded as invented.
- SIZED. It is shot at ${VIEWPORT.width}x${VIEWPORT.height}, and what a person sees there is all anyone sees.`;

/** How long a page gets to commit and draw before the shot is taken anyway. */
const SETTLE_MS = 30_000;

/** `mount.tsx` as one browser script, built once for the whole run. The page has
 *  no network, so the bundle is inlined and nothing about a shot depends on what
 *  a CDN felt like serving. */
export async function bundleMount(): Promise<string> {
  const result = await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "mount.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    minify: true,
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0]!.text;
}

/** Data a page reads back at mount, escaped once, in one place: `pageHtml` below
 *  and the thesys column's own page builder both write through this, so the one
 *  `</script` hazard has one spelling. */
export const jsonScript = (id: string, value: unknown): string =>
  `<script type="application/json" id="${id}">${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>`;

/** The tag `jsonScript` writes, as the pattern that reads it back — one spelling
 *  of the seam for everything that has to find it again: the clock below, and
 *  the liveness mutation that rewrites the tools inside it. */
export const jsonScriptRe = (id: string): RegExp =>
  new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`);

/** The months a world writes a date with, in the order `Date.UTC` numbers them. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * One date as a world wrote it, as an instant.
 *
 * Anything carrying no zone is read as UTC. The worlds speak Z — `2026-08-12`,
 * `2026-08-15 07:20`, `2026-08-12T15:10:00Z` are all in `worlds/` today — and
 * reading a zoneless one in the operator's zone is the same drift the page's own
 * `timezoneId` exists to stop, moved into the harness.
 */
function instant(written: string): number {
  const text = written.trim();
  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (named !== null) {
    const month = MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase());
    return month < 0 ? Number.NaN : Date.UTC(Number(named[3]), month, Number(named[2]));
  }
  const [day, clock] = text.split(/[T ]/);
  if (clock === undefined) return Date.parse(day!);
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(clock) ? `${day}T${clock}` : `${day}T${clock}Z`);
}

/**
 * A world's own word on when it is being looked at, in every spelling `worlds/`
 * uses today: "Today is 2026-08-15 and it is about 10:00 AM", "Today is Aug 12,
 * 2026", "as of today, 2026-08-12", "`sla_minutes_remaining` is measured from
 * now, 2026-08-12T15:10:00Z".
 *
 * The date, then the rest of the sentence, because several worlds put the hour
 * beside the day and a screen that reads a clock deserves the one the world set.
 */
const DECLARED =
  /\b(?:today is|today,|from now,)\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})([^.]*)/gi;

/** "and it is about 10:00 AM", "about 14:22" — the hour beside the day. */
const ABOUT = /\babout (\d{1,2}):(\d{2})\s*(AM|PM)?/i;

/** That hour as milliseconds into the day. A world writing 24-hour time says no
 *  meridiem, so its hour is already the hour. */
function intoTheDay([, written, minute, meridiem]: RegExpExecArray): number {
  const said = Number(written);
  const hour = meridiem === undefined ? said : (said % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);
  return (hour * 60 + Number(minute)) * 60_000;
}

/** Every date a tool answered with, wherever it sits in the rows. */
const DATED = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

const A_DAY = 86_400_000;

/**
 * The moment a world is being looked at — decided by the WORLD, never by the
 * laptop the run happens to be on.
 *
 * Every page used to be painted at the real wall-clock date, so a screen that
 * printed "5 days ago" for a ticket dated 2026-08-12 was right on one morning
 * and stale on the next, and the same saved page re-painted next year would say
 * something different again. A benchmark whose answer moves overnight is not
 * measuring the contender. The live run caught it: `support-desk/duplicate-merge`
 * was failed for calling 2026-08-12 "5 days ago" while calling the OLDER
 * 2026-08-10 "last week" — arithmetic against a clock the world does not share.
 *
 * Eleven of the fourteen worlds STATE when it is, in prose their contenders are
 * given verbatim, so that word is the answer wherever it exists. The obvious
 * alternative — the newest date in the rows, plus a day — is wrong for almost
 * every world here, because rows carry the FUTURE as readily as the past: a
 * lease that ends 2027-05-31, a coupon that expires 2026-12-31, an SLA due four
 * days out. Taken literally it puts `property-management`'s today in June 2027,
 * ten months past the "today is Aug 12 2026" its own tool descriptions state,
 * which would render every active lease expired. So it is only the FALLBACK, for
 * a world that says nothing — where it is at least deterministic, which is the
 * property that matters most. A world with neither a statement nor a date in it
 * pins nothing, and says so by answering `undefined`.
 */
export function worldToday(world: World): string | undefined {
  const says = [world.app, ...world.style, ...world.tools.map((tool) => tool.descriptor.description ?? "")].join("\n");
  // The LATEST of them, so a world that repeats itself does not depend on the
  // order its tools happen to be declared in, and the statement that names an
  // hour beats the one that names only the day.
  const declared = [...says.matchAll(DECLARED)]
    .map(([, day, tail]) => {
      const at = instant(day!);
      const about = ABOUT.exec(tail!);
      return about === null || Number.isNaN(at) ? at : at + intoTheDay(about);
    })
    .filter((at) => !Number.isNaN(at));
  if (declared.length > 0) return new Date(Math.max(...declared)).toISOString();

  const dated = [...JSON.stringify(world.tools.map(cannedResponse)).matchAll(DATED)]
    .map(([written]) => instant(written))
    .filter((at) => !Number.isNaN(at));
  return dated.length === 0 ? undefined : new Date(Math.max(...dated) + A_DAY).toISOString();
}

/**
 * The one seam every contender's page answers through, injected as the SAME
 * bytes whoever wrote the page: the recorder the click probe reads, answering
 * with the case's canned rows so a runtime refetch resolves instead of hanging.
 *
 * Two halves, because a contender may bring its own. The default recorder is
 * declared first, for a page that expects one to be there. The FEED is then
 * installed once the page has LOADED, over whatever `window.vendo` is by then,
 * and delegates to it — `claude-code` is told to define its own recorder so its
 * file works opened straight off disk, and a feed installed any earlier would
 * lose that whole column's presses to the page's own assignment. Wrapping
 * rather than replacing leaves `calls` and the page's own answer untouched.
 *
 * The feed itself is `parent.postMessage`: that is what lets the report page
 * show a press in an embedded screen as it happens, tagged with the contender
 * whose frame fired it — with no server and no shared state.
 *
 * The world's own `today` rides along beside the rows, and for the same reason
 * they do: `openBrowser` reads it back out and pins the page's clock to it, so
 * the clock TRAVELS WITH THE PAGE. A saved page re-painted by the regrade pass
 * or by the liveness pass — neither of which has a world in hand — is painted
 * under the very clock it was shot under, months later, on any laptop.
 *
 * A WRITE IS GUARDED (2026-08-18), because that is what this product does with
 * one. A destructive call is confirmed OUTSIDE the screen: the host answers
 * `pending-approval` with an id at press time, the renderer paints "Waiting for
 * your approval" in that control's own outcome slot
 * (`outcomeNotice` in `ui/src/tree/renderer.tsx`), and the decision arrives from a
 * surface the screen does not draw. The seam answered EVERY call `{status:"ok"}`
 * on the spot, so the only confirmation this product actually ships was
 * unrenderable on any page here — while a contender following its doctrine and
 * building no confirm step of its own was failed on rubric lines asking for one.
 * A write is parked and then approved a moment later, so the round trip completes
 * where nobody has an approvals queue to answer with; the ask and its approval
 * both reach the live feed, and the call the floor grades carries what the guard
 * did with it. Which tools those are is `riskOf`'s answer and nobody else's — the
 * same reading the write row and `checkConfirmation` use — so a world declares
 * its own destructive verbs by not writing rows for them.
 *
 * READS are untouched: a screen fetching what it shows must never wait on an
 * approval to draw. And a page that brings its own `window.vendo` answers itself,
 * exactly as it already does for reads — the contract tells every contender the
 * recorder is already there and not to define one.
 */
function seam(world: World, contender: string): string {
  const tools = Object.fromEntries(world.tools.map((tool) => [tool.name, cannedResponse(tool) as Json]));
  const writes = world.tools.filter((tool) => tool.descriptor.risk === "write").map((tool) => tool.name);
  const today = worldToday(world);
  // Prefixed, unlike the three ids beside it, because this one is the harness
  // talking to ITSELF: no page reads it, and `today` unqualified is an id a real
  // screen would plausibly use for a real panel — whose `getElementById("today")`
  // would then find this tag instead. Written as a script so `shot()` strips it
  // with the others: the clock the harness set is not evidence about the screen.
  return `${jsonScript("tools", tools)}
${today === undefined ? "" : jsonScript("genbench-today", today)}
<script>
(function () {
  var tools = JSON.parse(document.getElementById("tools").textContent);
  var writes = ${JSON.stringify(writes)};
  var contender = ${JSON.stringify(contender)};
  var post = function (message) {
    message.genbench = "call";
    message.contender = contender;
    message.ts = Date.now();
    try {
      parent.postMessage(message, "*");
    } catch (ignored) {}
  };
  var asks = 0;
  window.vendo = {
    calls: [],
    callTool: function (name, args) {
      var call = { name: name, args: args };
      window.vendo.calls.push(call);
      if (!Object.hasOwn(tools, name)) {
        return { status: "error", error: { code: "not-found", message: "no tool " + name } };
      }
      if (writes.indexOf(name) < 0) return { status: "ok", output: tools[name] };
      asks += 1;
      var approvalId = "apr_" + asks;
      call.status = "pending-approval";
      call.approvalId = approvalId;
      // Approved once the press's own work is done, and recorded on the very
      // call it released — so a guarded write reads as one round trip and never
      // as two presses. A MICROtask rather than a timer: the page still gets the
      // parked answer back from its handler, while anything reading the record
      // from outside the page (the probe, a test) reads it after the queue has
      // drained, so the trace does not depend on which side of a frame the read
      // landed on. With a timer it did, and one page recorded its first press
      // approved and its second still pending.
      queueMicrotask(function () {
        call.status = "ok";
        post({ name: name, args: args, approved: approvalId });
      });
      return { status: "pending-approval", approvalId: approvalId };
    },
  };
  addEventListener("load", function () {
    var vendo = window.vendo;
    var inner = vendo.callTool;
    vendo.callTool = function (name, args) {
      post({ name: name, args: args });
      return inner.call(vendo, name, args);
    };
  });
})();
</script>`;
}

/**
 * The face the world ships, declared as a data URL because the page has no
 * network. Injected into EVERY contender's page as these same bytes: a family
 * the theme names and no page can resolve is a style rule nobody can check by
 * looking, and one contender resolving it while another does not would grade
 * the harness.
 *
 * `font-display:block` so a shot can never catch the fallback mid-swap. A world
 * that ships no face says nothing at all, and every column falls back together.
 */
export function fontFace(world: World): string {
  if (world.font === undefined) return "";
  const family = world.theme.typography.fontFamily.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
  return `<style>@font-face{font-family:${JSON.stringify(family)};font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${world.font}) format("woff2")}</style>`;
}

/**
 * The page a contender is judged on: a root to mount into, the case's data, and
 * the script that paints it. The theme rides as JSON and is applied through the
 * product's own `applyThemeVars`, so nothing here re-implements theming.
 */
export function pageHtml(payload: UIPayload, world: World, bundle: string, contender: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench</title><style>
html,body{margin:0;padding:0;background:var(--vendo-color-background,#fff);}
#root{padding:20px;}
</style>
${fontFace(world)}
${seam(world, contender)}
</head><body><div id="root"></div>
${jsonScript("payload", payload)}
${jsonScript("theme", world.theme)}
<script>${bundle.replaceAll("</script", "<\\/script")}</script>
</body></html>`;
}

/** Where the harness gets to speak in a document it did not write. */
const ENTRY = /<head[^>]*>|<body[^>]*>/i;

/**
 * A contender that wrote its own document gets the world's face, the seam and
 * the settle signal injected, and nothing else: the page it wrote is the page
 * that mounts, is shot and is probed. The settle belongs to the harness because
 * a hand-written page has no reason to know the shooter is waiting for it.
 */
export function authoredPage(html: string, world: World, contender: string): string {
  const injected = `${fontFace(world)}
${seam(world, contender)}
<script>addEventListener("load", function () {
  requestAnimationFrame(function () { requestAnimationFrame(function () { window.__settled = true; }); });
});</script>`;
  const entry = ENTRY.exec(html);
  return entry === null ? injected + html : html.replace(entry[0], () => entry[0] + injected);
}

/**
 * What a chart writes to measure with, rather than to say: the axis TICK layers,
 * whose scale is arithmetic no tool returned, and `#recharts_measurement_span`,
 * an offscreen scratch pad no human has seen and `innerText` reports anyway.
 *
 * Both are hidden for the extraction and restored before the shot. Nothing else
 * is, so a fabricated number in the screen's own copy still fails.
 * `axis.test.ts` pins both halves in a real browser, and fails loudly if
 * recharts ever moves the text.
 *
 * The SAME selectors on every page, whoever wrote it. They were once the Kit's
 * alone — a contender's own document got no exclusion, on the reasoning that
 * those class names in hand-written markup would be a hiding place rather than a
 * chart. That reasoning graded the harness: a Kit chart's axis was ungraded and a
 * hand-drawn chart's identical axis was fabrication, so the column that could not
 * use the Kit was failed for drawing the same picture. The exclusion is a
 * property of what the text IS, not of who emitted it. The cost is stated in the
 * README: a number that appears ONLY on a chart axis is ungraded for everyone,
 * and any contender may put a number there — where nobody, including its author,
 * can read it as a claim about the data.
 *
 * `[class*=...]` rather than the exact class, so the tick VALUE and the tick
 * LABELS layer both go, and so a hand-written chart that names its ticks the way
 * the Kit's does is read the same way.
 */
const CHART_SCAFFOLDING = '[class*="recharts-cartesian-axis-tick"], #recharts_measurement_span';

/** How many wide tables one screen gets a picture of. Past three, another
 *  picture buys less than the judge's attention on the screen itself costs. */
const MOST_WIDE_TABLES = 3;

/**
 * How much a scroller has to hide before it counts as hiding anything.
 *
 * A one- or two-pixel reading is not a column past a fold, it is arithmetic:
 * rounded column widths summed against a rounded room, a fractional border, a
 * scrollbar gutter — the same overshoot `unrounded` exists for in the Kit's own
 * `data-table.tsx`. Believing one is expensive. A 2px artifact on
 * `subscription-billing/renewal-schedule`'s root Stack armed this whole path on
 * 45 of 54 vendo cases, and on that one it cost the case. 8px is under one
 * character at any size any screen here draws, so nothing a person could read
 * hides beneath this.
 */
const PAST_THE_FOLD_PX = 8;

/**
 * The widest picture worth taking.
 *
 * `max-content` leaves the expanded block's own width INDEFINITE, and a
 * `width:100%` child of an indefinite block resolves against Chromium's 1e6px
 * sentinel — measured at 1,000,002px on the case above, where a `<select>` did
 * exactly that and Chromium answered the element shot with `Unable to capture
 * screenshot`. A ceiling keeps the picture inside what Chromium will capture
 * whatever the layout does, and past a few thousand pixels a shot of a table is
 * unreadable anyway.
 */
const WIDEST_SHOT_PX = 4000;

/** The mark the expansion below leaves on a container so the shooter out here can
 *  find it again, taken off with the widths it set. */
const WIDE = "data-genbench-wide";

/**
 * A table that scrolls sideways, shot at its FULL width (2026-08-18).
 *
 * The graded shot is the `VIEWPORT`, and a table wider than that keeps its
 * right-hand columns past the fold — where a person reaches them by scrolling and
 * the judge could not reach them at all. Three style lines were failed on
 * conventions that were on the screen the whole time, in the columns nobody
 * scrolled to. So the fold gets its own picture, and the judge is told what it is
 * looking at (`SYSTEM_PROMPT` in `judge.ts`). Written against the frame rather
 * than against a width, so widening the frame is one edit up there and none here.
 *
 * The container is found from the TABLE outwards, and the walk STOPS at the first
 * ancestor that clips the table at all — that element is where the table's
 * overflow ends, so the Kit's `overflow-x:auto` wrapper (`data-table.tsx`) and a
 * hand-written one are found by one rule, and a column that draws its table with
 * `role="table"` divs is read the same way. If that wrapper scrolls, its picture
 * is what scrolling reveals; if it merely clips (`hidden`, `clip`) then nothing
 * past it is reachable by a person either, so there is nothing to reveal.
 *
 * Nothing further out is ever the answer, and the page itself never is. Walking
 * on until SOMETHING measured wide is what broke the case this guard is written
 * from: the walk climbed past a scroll wrapper with nothing to scroll, out to
 * `subscription-billing/renewal-schedule`'s root Stack, and widened the page's own
 * layout — which resolved a `width:100%` `<select>` to 1e6px and threw out of the
 * shot. Anything with nothing to scroll pays one `evaluate` and no screenshots,
 * which is most cases.
 *
 * `max-content` rather than a measured width: it is whatever the table asks for,
 * including columns a resize observer hands back once the room is there. And the
 * page is put back exactly as it was, because the probe walks it next — a table
 * left expanded is not the screen that was graded.
 */
async function wideTables(page: Page): Promise<Buffer[]> {
  const was = await page.evaluate(
    ([mark, most, fold, widest]: [string, number, number, number]) => {
      const scrollers = new Set<HTMLElement>();
      for (const table of document.querySelectorAll<HTMLElement>('table, [role="table"]')) {
        // Never `document.body` or the element above it: a document that scrolls
        // sideways is the page's own layout, not a table's fold.
        for (let node: HTMLElement | null = table; node !== null && node !== document.body; node = node.parentElement) {
          const overflowX = getComputedStyle(node).overflowX;
          if (overflowX === "visible") continue;
          if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth - node.clientWidth > fold) {
            scrollers.add(node);
          }
          break;
        }
      }
      return [...scrollers].slice(0, most).map((node, index) => {
        const style = node.getAttribute("style");
        node.setAttribute(mark, String(index));
        node.style.width = "max-content";
        node.style.maxWidth = `${widest}px`;
        node.style.overflow = "visible";
        return style;
      });
    },
    [WIDE, MOST_WIDE_TABLES, PAST_THE_FOLD_PX, WIDEST_SHOT_PX] as [string, number, number, number],
  );

  const shots: Buffer[] = [];
  // One at a time: two element shots of one page would race each other's scroll.
  for (let index = 0; index < was.length; index += 1) {
    try {
      shots.push(await page.locator(`[${WIDE}="${index}"]`).screenshot());
    } catch {
      // A BONUS picture, and the screen it belongs to has already been shot and
      // read. So a shot that cannot be taken costs nothing but itself: no record,
      // the styles below still come off, and the next one is still tried. It cost
      // a whole case once — `Unable to capture screenshot` threw out of `shot()`
      // and auto-failed all eleven of one case's rubric lines.
    }
  }

  await page.evaluate(
    ([mark, styles]: [string, Array<string | null>]) => {
      styles.forEach((style, index) => {
        const node = document.querySelector(`[${mark}="${index}"]`);
        if (node === null) return;
        node.removeAttribute(mark);
        if (style === null) node.removeAttribute("style");
        else node.setAttribute("style", style);
      });
    },
    [WIDE, was] as [string, Array<string | null>],
  );
  return shots;
}

export interface Shot {
  readonly png: Buffer;
  /** Every horizontally scrollable table on the settled screen, shot at its full
   *  scroll width — what a person reaches by scrolling sideways and the viewport
   *  shot above cannot hold. Empty for a screen with nothing to scroll, which is
   *  most of them. */
  readonly tables: readonly Buffer[];
  /** The page's visible text minus chart axis ticks — the same extraction for
   *  every contender, which is what makes the fabrication check comparable
   *  across artifact formats. */
  readonly visibleText: string;
  /** The document as the browser holds it once the screen has settled, minus
   *  the script bodies — the judge's SOURCE evidence, in one format whoever
   *  wrote the page. The saved FILE cannot be that channel: the page the
   *  product renders inlines its whole runtime, so every one of that column's
   *  cases reached the judge as `prompt is too long: 1791560 tokens > 1000000
   *  maximum` and was failed for it, while the baselines' authored pages graded
   *  fine. What painted is smaller than what was saved, and better evidence. */
  readonly dom: string;
  /** Something took up space AND the browser reported no errors doing it. */
  readonly renders: boolean;
  readonly consoleErrors: readonly string[];
}

export interface Visit {
  readonly page: Page;
  shot(): Promise<Shot>;
  /** The same page again, from scratch — what the click probe puts between two
   *  candidates so neither inherits the other's state. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface Shooter {
  /** Every page the same way: the same viewport, the same settle, the same
   *  extraction, the same exclusions. Nothing here knows who wrote the document. */
  visit(html: string): Promise<Visit>;
  close(): Promise<void>;
}

/** The world's `today` as `seam` wrote it into the page. */
const TODAY = jsonScriptRe("genbench-today");

/** One browser for the whole run; every case reuses it. */
export async function openBrowser(): Promise<Shooter> {
  const browser: Browser = await chromium.launch();
  return {
    async visit(html) {
      // UTC, because the worlds speak Z and the screens must too. Chromium takes
      // the operator's zone otherwise, so every `2026-08-12T15:10:00Z` a tool
      // answered painted seven hours earlier than it says on a Pacific laptop —
      // and the judge, comparing the screen against the tool data it is given in
      // Z, correctly reported the difference as invention. It failed the honesty
      // line on `support-desk/ticket-detail` and `queue-split` for exactly that
      // ("message timestamps like 'Aug 10, 1:12 AM' do not correspond to any
      // tool value (08:12Z)"), in both columns, which is a harness bug both
      // columns were charged for.
      const page = await browser.newPage({ viewport: { ...VIEWPORT }, timezoneId: "UTC" });
      // And the DAY the page believes it is, from the world rather than from the
      // calendar. `setFixedTime` rather than `install`: it freezes what `Date`
      // reads while leaving every timer running on real time, which the settle
      // depends on — the double `requestAnimationFrame` in `authoredPage` and in
      // `mount.tsx`, `mount.tsx`'s VM grace `setTimeout`, and the polling behind
      // `waitForFunction` below. `install` would stop all four and nothing would
      // ever settle. Set before the first `setContent`, and it rides an init
      // script, so `reset()` re-paints under the same clock.
      const today = TODAY.exec(html);
      if (today !== null) await page.clock.setFixedTime(new Date(JSON.parse(today[1]!) as string));
      // "NO network at all" is a rule every contender is graded on, so the
      // harness has to be held to it too: a CDN font that happens to resolve on
      // the operator's laptop is a screen that cannot be reproduced anywhere
      // else. `data:` and `blob:` are not requests, so the world's face and the
      // inlined bundle still arrive.
      await page.context().route("**/*", (route) => route.abort());
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));

      const paint = async (): Promise<void> => {
        await page.setContent(html, { waitUntil: "load" });
        // A page that never sets the signal is a page that never finished, and
        // saying so is worth more than an exception that ends the whole run.
        await page
          .waitForFunction(() => window.__settled === true, undefined, { timeout: SETTLE_MS })
          .catch(() => consoleErrors.push(`the page never settled within ${SETTLE_MS}ms`));
      };
      await paint();

      return {
        page,
        async shot() {
          const { visibleText, dom, mounted } = await page.evaluate((selector: string) => {
            // `visibility`, not `display`: Chrome's `innerText` reports SVG text
            // in a `display:none` subtree, and reports it correctly hidden here.
            const scaffolding = [...document.querySelectorAll<SVGElement | HTMLElement>(selector)];
            const was = scaffolding.map((element) => element.style.visibility);
            for (const element of scaffolding) element.style.visibility = "hidden";
            // `innerText` writes nothing between two inline boxes, so a row's
            // "Housing $2850.00" beside its "67%" came back as $2850.0067 — a
            // token no screen printed, reported as fabrication, while the honest
            // percentage never became a token at all. Siblings escaped that only
            // by rounding luck.
            //
            // So the boundary is written in: a space between text from DIFFERENT
            // elements, nothing between text from the same one. Different
            // element, different value; one element, one run of text handed over
            // as written, which is what keeps "$4,243.11" whole even when React
            // splits a line into several nodes. Element-wise rather than
            // box-wise, so an SVG chart's labels separate on the same rule as a
            // div's — the extraction has to be identical whatever a contender
            // drew with. `checkVisibility` is what `innerText` was giving for
            // free, and it answers for ancestors, so the scaffolding hidden just
            // above and anything the page hid itself stay out of the reading.
            //
            // Nothing here may be a NAMED function: tsx compiles this file with
            // esbuild's keepNames, which wraps one in a `__name` helper that
            // exists in node and not in the page. Vitest's transform adds no
            // such helper, so the suite cannot catch it — a real run is where it
            // surfaces, as `__name is not defined`, on every column at once.
            const parts: string[] = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let previous: Element | null = null;
            while (walker.nextNode() !== null) {
              const text = walker.currentNode as Text;
              const parent = text.parentElement;
              if (parent === null || !parent.checkVisibility({ visibilityProperty: true })) continue;
              if (previous !== null && previous !== parent) parts.push(" ");
              parts.push(text.data);
              previous = parent;
            }
            const visibleText = parts.join("");
            scaffolding.forEach((element, index) => (element.style.visibility = was[index]!));
            // A clone, because the page is probed after this and must keep
            // everything it has. The scripts go because they have already run:
            // what they built is the markup around them, and the bytes are the
            // one part of a page that can be megabytes long.
            const shell = document.documentElement.cloneNode(true) as HTMLElement;
            for (const script of shell.querySelectorAll("script")) script.remove();
            return {
              visibleText,
              dom: shell.outerHTML,
              // Anywhere in the body, not just under `#root`: a contender that
              // wrote its own document has no root to mount into, and grading it
              // as blank for that would be measuring the harness.
              mounted: [...document.querySelectorAll("body *")].some((element) => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.height > 0;
              }),
            };
          }, CHART_SCAFFOLDING);
          return {
            // The viewport, not the whole document: the contract says what a
            // person sees at this size is all anyone sees, and a full-page shot
            // handed the judge a screen no person was ever shown.
            png: await page.screenshot(),
            // Then the fold's own pictures — taken after the shot and after the
            // reading above, both of which are of the screen exactly as it was
            // graded. This is the only thing here that touches the page, and it
            // puts back what it moved.
            tables: await wideTables(page),
            visibleText,
            dom,
            renders: mounted && consoleErrors.length === 0,
            consoleErrors: [...consoleErrors],
          };
        },
        reset: paint,
        close: () => page.close(),
      };
    },
    close: () => browser.close(),
  };
}
