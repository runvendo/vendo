// Temporary ENG-229 probe — watches the stage status after Start. NOT committed.
import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
page.on("console", (m) => console.log(`console[${m.type()}]:`, m.text().slice(0, 300)));
page.on("requestfailed", (r) => console.log("request-failed:", r.url().slice(0, 120), r.failure()?.errorText));
page.on("response", (r) => { if (r.status() >= 400) console.log("http-" + r.status() + ":", r.url().slice(0, 120)); });

await page.goto("http://localhost:3000/vendo", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".fl-voice-stage", { timeout: 20000 });
await page.getByRole("button", { name: "Start voice" }).click();

for (let i = 0; i < 22; i += 1) {
  await page.waitForTimeout(2000);
  const status = await page.locator(".fl-voice-status").textContent().catch(() => "?");
  const state = await page.locator(".fl-voice-stage").getAttribute("data-state").catch(() => "?");
  const banner = await page.locator(".fl-voice-banner").textContent().catch(() => "");
  console.log(`t=${(i + 1) * 2}s state=${state} status="${status}" banner="${banner}"`);
  if (state === "listening" || state === "error") break;
}
await browser.close();
