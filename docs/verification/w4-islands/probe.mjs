/** W4b — single-prompt probe: create, wait, dump the rendered surface. */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const require = createRequire(join(repo, "packages", "ui", "package.json"));
const { chromium } = require("@playwright/test");

const BASE = "http://localhost:3000";
const prompt = process.argv[2];
const waitSeconds = Number(process.argv[3] ?? 150);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[console-error]", m.text().slice(0, 300)); });
await page.goto(`${BASE}/login`);
await page.getByRole("textbox", { name: "Password" }).fill("maple-demo");
await page.getByRole("textbox", { name: "Password" }).press("Enter");
await page.waitForURL(`${BASE}/`, { timeout: 30_000 });
await page.goto(`${BASE}/vendo`);
const composer = page.getByRole("textbox", { name: "Message" });
await composer.fill(prompt);
await composer.press("Enter");
for (let elapsed = 0; elapsed < waitSeconds; elapsed += 10) {
  await page.waitForTimeout(10_000);
  const streaming = await page.getByText(/Vendo apps create/i).first().isVisible().catch(() => false);
  console.log(`[t+${elapsed + 10}s] streaming=${streaming}`);
  if (!streaming && elapsed > 60) break;
}
// Dump the last assistant message subtree as text + the island frame count.
const article = page.locator('article[aria-label="assistant message"]').last();
console.log("--- assistant message text ---");
console.log((await article.innerText().catch(() => "(none)")).slice(0, 1200));
const islands = page.locator('iframe[title^="Generated component:"]');
const count = await islands.count();
console.log("--- generated islands on page:", count);
for (let i = 0; i < count; i += 1) {
  console.log("  island:", await islands.nth(i).getAttribute("title"));
  const inner = islands.nth(i).contentFrame().locator("iframe").contentFrame();
  console.log("  inner text:", (await inner.locator("body").innerText().catch(() => "(unreadable)")).slice(0, 400).replace(/\n/g, " | "));
}
await page.screenshot({ path: join(here, "probe.png") });
await browser.close();
