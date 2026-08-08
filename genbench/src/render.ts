import { chromium, type Browser, type Page } from "@playwright/test";
import type { Json, UIPayload } from "@vendoai/core";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "./world.js";

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
 * The page a contender is judged on: a root to mount into, the case's data, and
 * the script that paints it. The theme rides as JSON and is applied through the
 * product's own `applyThemeVars`, so nothing here re-implements theming.
 *
 * The later DIY and claude-code contenders write this file themselves — the page
 * IS their artifact, and they bypass the compile entirely. Everything a page can
 * rely on is therefore in the markup below and nowhere else.
 */
export function pageHtml(payload: UIPayload, world: World, bundle: string): string {
  const tools = Object.fromEntries(world.tools.map((tool) => [tool.name, (tool.data ?? { ok: true }) as Json]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench</title><style>
html,body{margin:0;padding:0;background:var(--vendo-color-background,#fff);}
#root{padding:20px;}
</style></head><body><div id="root"></div>
${jsonScript("payload", payload)}
${jsonScript("theme", world.theme)}
${jsonScript("tools", tools)}
<script>${bundle.replaceAll("</script", "<\\/script")}</script>
</body></html>`;
}

export interface Shot {
  readonly png: Buffer;
  /** `document.body.innerText` — the same extraction for every contender, which
   *  is what makes the fabrication check comparable across artifact formats. */
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
  visit(html: string): Promise<Visit>;
  close(): Promise<void>;
}

/** One browser for the whole run; every case reuses it. */
export async function openBrowser(): Promise<Shooter> {
  const browser: Browser = await chromium.launch();
  return {
    async visit(html) {
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
          const { visibleText, mounted } = await page.evaluate(() => ({
            visibleText: document.body.innerText,
            mounted: [...document.querySelectorAll("#root *")].some((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            }),
          }));
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
