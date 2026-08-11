import { chromium, type Browser, type Page } from "@playwright/test";
import type { Json, UIPayload } from "@vendoai/core";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cannedResponse, type World } from "./world.js";

/** A banking app's column. Every contender is shot at the same size, so the
 *  screenshots stack side by side in the report. */
const VIEWPORT = { width: 480, height: 900 } as const;

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
 * What a chart writes to measure with, rather than to say: the tick LABELS layer
 * (not `.recharts-cartesian-axis`, which holds the line and no text), whose
 * scale is arithmetic no tool returned, and `#recharts_measurement_span`, an
 * offscreen scratch pad no human has seen and `innerText` reports anyway.
 *
 * Both are hidden for the extraction and restored before the shot. Nothing else
 * is, so a fabricated number in the screen's own copy still fails.
 * `axis.test.ts` pins both halves in a real browser, and fails loudly if
 * recharts ever moves the text.
 *
 * It is the KIT's scaffolding, so only a page the HARNESS compiled gets the
 * exclusion. A contender that wrote its own document never loaded the Kit and
 * cannot draw a recharts axis: those class names in its markup would not be a
 * chart, they would be a container that keeps a fabricated number out of the
 * text the floor reads while leaving it in the screenshot a person sees.
 */
const CHART_SCAFFOLDING = ".recharts-cartesian-axis-tick-labels, #recharts_measurement_span";

export interface Shot {
  readonly png: Buffer;
  /** The page's visible text minus chart axis ticks — the same extraction for
   *  every contender, which is what makes the fabrication check comparable
   *  across artifact formats. */
  readonly visibleText: string;
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
  /** `authored` marks a document the CONTENDER wrote — the one page that gets
   *  no chart-scaffolding exclusion, because it never loaded the Kit. */
  visit(html: string, page?: { readonly authored?: boolean }): Promise<Visit>;
  close(): Promise<void>;
}

/** One browser for the whole run; every case reuses it. */
export async function openBrowser(): Promise<Shooter> {
  const browser: Browser = await chromium.launch();
  return {
    async visit(html, options) {
      const scaffolding = options?.authored === true ? "" : CHART_SCAFFOLDING;
      const page = await browser.newPage({ viewport: { ...VIEWPORT } });
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
          const { visibleText, mounted } = await page.evaluate((selector: string) => {
            // `visibility`, not `display`: Chrome's `innerText` reports SVG text
            // in a `display:none` subtree, and reports it correctly hidden here.
            const scaffolding =
              selector === "" ? [] : [...document.querySelectorAll<SVGElement | HTMLElement>(selector)];
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
            return {
              visibleText,
              // Anywhere in the body, not just under `#root`: a contender that
              // wrote its own document has no root to mount into, and grading it
              // as blank for that would be measuring the harness.
              mounted: [...document.querySelectorAll("body *")].some((element) => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.height > 0;
              }),
            };
          }, scaffolding);
          return {
            png: await page.screenshot({ fullPage: true }),
            visibleText,
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
