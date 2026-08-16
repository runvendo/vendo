import { chromium, type Browser, type Page } from "@playwright/test";
import type { Json, UIPayload } from "@vendoai/core";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cannedResponse, type World } from "./world.js";

/** A banking app's column. Every contender is shot at the same size, so the
 *  screenshots stack side by side in the report. */
const VIEWPORT = { width: 480, height: 900 } as const;

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
- CONFIRMED. A step that confirms before acting must carry \`role="dialog"\`, or the call behind it is never seen.
- FINISHED. The screen is considered settled two frames after the page loads, and it is shot then. Draw synchronously: anything painted later may not be in the picture anyone grades.
- HONEST. Every number and every date on the screen must come from the tool data above — shown as it is, or computed from it. Anything else is graded as invented.
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

const jsonScript = (id: string, value: unknown): string =>
  `<script type="application/json" id="${id}">${JSON.stringify(value).replaceAll("<", "\\u003c")}</script>`;

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
 */
function seam(world: World, contender: string): string {
  const tools = Object.fromEntries(world.tools.map((tool) => [tool.name, cannedResponse(tool) as Json]));
  return `${jsonScript("tools", tools)}
<script>
(function () {
  var tools = JSON.parse(document.getElementById("tools").textContent);
  var contender = ${JSON.stringify(contender)};
  window.vendo = {
    calls: [],
    callTool: function (name, args) {
      window.vendo.calls.push({ name: name, args: args });
      return Object.hasOwn(tools, name)
        ? { status: "ok", output: tools[name] }
        : { status: "error", error: { code: "not-found", message: "no tool " + name } };
    },
  };
  addEventListener("load", function () {
    var vendo = window.vendo;
    var inner = vendo.callTool;
    vendo.callTool = function (name, args) {
      try {
        parent.postMessage({ genbench: "call", contender: contender, name: name, args: args, ts: Date.now() }, "*");
      } catch (ignored) {}
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

export interface Shot {
  readonly png: Buffer;
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

/** One browser for the whole run; every case reuses it. */
export async function openBrowser(): Promise<Shooter> {
  const browser: Browser = await chromium.launch();
  return {
    async visit(html) {
      const page = await browser.newPage({ viewport: { ...VIEWPORT } });
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
