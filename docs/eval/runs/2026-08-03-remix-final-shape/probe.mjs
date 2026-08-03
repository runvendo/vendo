/**
 * Judging probe — reads the RENDERED fork against the PASS bar (interactive
 * fidelity: the range switcher still switches). Never edits, never forks:
 * this is the judge's eyes, not a measured step.
 *
 * usage: node probe.mjs <shot-name> [range-label]
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../packages/ui/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const HOST = process.env.EVAL_HOST ?? "maple";
const BASE = HOST === "maple" ? "http://localhost:4310/maple" : "http://localhost:4311/cadence";
const SLOT = HOST === "maple" ? "NetWorthView" : "MissingDocsHero";
const hash8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const PIN = `Pinned${SLOT}${hash8(SLOT)}`;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const [name, label = "1Y"] = process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
if (HOST === "maple") {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await Promise.all([page.waitForURL(/\/maple\/?$/), page.click('button[type="submit"]')]);
}
await page.goto(`${BASE}/`);
await page.waitForSelector(`iframe[title="Generated component: ${PIN}"]`, { timeout: 60_000 });
await page.waitForTimeout(5_000);
// The jail nests srcdoc frames — find the one actually holding the fork.
let clicked = false;
for (const frame of page.frames()) {
  const target = frame.locator(`button:text-is("${label}")`).first();
  if (frame !== page.mainFrame() && (await target.count().catch(() => 0))) {
    await target.click();
    console.log(`clicked ${label} inside the jail`);
    await page.waitForTimeout(2_000);
    clicked = true;
    break;
  }
}
if (!clicked) console.log(`no ${label} button found inside any jail frame`);
await page.screenshot({ path: path.join(DIR, "shots", `${name}.png`), fullPage: false });
console.log(`shots/${name}.png`);
await browser.close();
