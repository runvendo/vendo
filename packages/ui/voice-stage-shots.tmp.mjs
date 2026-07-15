// Temporary ENG-229 stage-focused shots (uses leftover pending approval). NOT committed.
import { chromium } from "@playwright/test";

const OUT = "/tmp/eng229-shots";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
const page = await ctx.newPage();
await page.goto("http://localhost:3000/vendo", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".fl-voice-stage");
const stage = page.locator(".fl-voice-stage");

for (let attempt = 0; attempt < 5; attempt += 1) {
  await page.getByRole("button", { name: "Start voice" }).click();
  await page.waitForTimeout(2000);
  if ((await stage.getAttribute("data-state")) !== "idle") break;
}
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(2000);
  if ((await stage.getAttribute("data-state")) === "listening") break;
}
const composer = page.getByPlaceholder("Ask anything");
await composer.waitFor({ state: "visible", timeout: 20000 });
await composer.fill("Send $25 to Jordan Avery from my checking account");
await composer.press("Enter");
await stage.scrollIntoViewIfNeeded();
await page.waitForSelector(".fl-voice-consent", { timeout: 90000 });
await stage.screenshot({ path: `${OUT}/12-stage-consent-critical.png` });
console.log("shot: 12-stage-consent-critical");

await page.locator(".fl-voice-consent button", { hasText: "Decline" }).click();
await page.waitForSelector(".fl-voice-consent.is-receipt", { timeout: 10000 });
await stage.screenshot({ path: `${OUT}/13-stage-receipt-declined.png` });
console.log("shot: 13-stage-receipt-declined");

// Drain any remaining pending approvals so the store is clean.
for (let i = 0; i < 5; i += 1) {
  await page.waitForTimeout(2500);
  const decline = page.locator(".fl-voice-consent button", { hasText: "Decline" });
  if (!(await decline.count())) break;
  await decline.click();
}

await stage.screenshot({ path: `${OUT}/14-stage-listening.png` });
console.log("shot: 14-stage-listening");
await page.getByRole("button", { name: "Mute" }).click();
await page.waitForTimeout(300);
await stage.screenshot({ path: `${OUT}/15-stage-muted.png` });
console.log("shot: 15-stage-muted");
await page.getByRole("button", { name: "Transcript" }).click();
await page.waitForSelector(".fl-voice-drawer");
await stage.screenshot({ path: `${OUT}/16-stage-drawer.png` });
console.log("shot: 16-stage-drawer");
await page.getByRole("button", { name: "Stop" }).click();
await browser.close();
console.log("DONE");
