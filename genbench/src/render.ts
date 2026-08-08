import { chromium, type Browser } from "@playwright/test";
import {
  defaultVendoTheme,
  resolveTheme,
  themeCssVariables,
  type Json,
  type ToolOutcome,
  type UIPayload,
  type VendoTheme,
} from "@vendoai/core";
import { PayloadView } from "@vendoai/ui/tree";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

/** A banking app's column. Every contender is shot at the same size, so the
 *  screenshots stack side by side in the report. */
const VIEWPORT = { width: 480, height: 900 } as const;

const noAction = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** Payload -> a standalone document. The Kit styles entirely through
 *  `var(--vendo-*)` with baked-in fallbacks and ships no stylesheet, so the
 *  host theme arrives as the one `:root` block below and nothing else is
 *  needed to paint it in the host's brand. */
export function treeHtml(payload: UIPayload, theme: VendoTheme): string {
  const body = renderToString(
    createElement(PayloadView, {
      payload,
      components: {},
      data: (payload as { data?: Record<string, Json> }).data,
      onAction: noAction,
    }),
  );
  const vars = Object.entries(themeCssVariables(resolveTheme(defaultVendoTheme, theme)))
    .map(([name, value]) => `${name}: ${value};`)
    .join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>genbench</title><style>
:root{${vars}}
html,body{margin:0;padding:0;background:var(--vendo-color-background);}
.vendo-root{padding:20px;font-family:var(--vendo-font-family);font-size:var(--vendo-font-size);color:var(--vendo-color-text);}
</style></head><body><div class="vendo-root">${body}</div></body></html>`;
}

export interface Shot {
  readonly png: Buffer;
  /** `document.body.innerText` — the same extraction for every contender, which
   *  is what makes the fabrication check comparable across artifact formats. */
  readonly visibleText: string;
  /** At least one element actually took up space on the page. */
  readonly renders: boolean;
}

export interface Shooter {
  shot(html: string): Promise<Shot>;
  close(): Promise<void>;
}

/** One browser for the whole run; every case reuses it. */
export async function openBrowser(): Promise<Shooter> {
  const browser: Browser = await chromium.launch();
  return {
    async shot(html) {
      const page = await browser.newPage({ viewport: { ...VIEWPORT } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const { visibleText, renders } = await page.evaluate(() => {
          const painted = [...document.querySelectorAll(".vendo-root *")].some((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          });
          return { visibleText: document.body.innerText, renders: painted };
        });
        return { png: await page.screenshot({ fullPage: true }), visibleText, renders };
      } finally {
        await page.close();
      }
    },
    close: () => browser.close(),
  };
}
