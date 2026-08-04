/**
 * Lane D evidence capture: drives the real chrome in headless Chromium and
 * records two videos —
 *   life.webm  : ask → close panel mid-run → pill narrates with the ring →
 *                completion toast → View reopens the panel to the record
 *   signals.webm: ask pending → numbered badge → decide → clears; result
 *                unseen → quiet dot → open → clears
 * Converted to GIF by the caller (ffmpeg).
 */
import { chromium } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";

const BASE = process.env.CAPTURE_BASE ?? "http://127.0.0.1:4274";
const OUT = process.env.CAPTURE_OUT ?? "/tmp/lane-d-capture";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function record(name, run) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1_180, height: 760 },
    recordVideo: { dir: `${OUT}/${name}`, size: { width: 1_180, height: 760 } },
    colorScheme: "light",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".fl-launcher");
  await run(page);
  await context.close();
  await browser.close();
}

const shot = (page, file) => page.screenshot({ path: `${OUT}/${file}` });

await record("life", async page => {
  await sleep(600);
  await shot(page, "01-idle-pill.png");
  await page.getByRole("button", { name: "AI agent" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("How did my July spending go?");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  // Let the first beat land, then LEAVE mid-run.
  await page.waitForSelector(".fl-ribbon");
  await sleep(900);
  await shot(page, "02-running-in-panel.png");
  await page.getByRole("button", { name: "Close Vendo" }).click();
  // The run did not stop: the pill picks up the narration.
  await page.waitForSelector(".fl-launcher-beat");
  await sleep(1_200);
  await shot(page, "03-pill-narrates-indeterminate.png");
  await page.waitForSelector('.fl-launcher-ring[data-vendo-ring="determinate"]');
  await sleep(1_400);
  await shot(page, "04-pill-ring-determinate.png");
  // The result finds the user where they are.
  await page.waitForSelector(".fl-launcher-toast");
  await sleep(900);
  await shot(page, "05-completion-toast.png");
  await page.getByRole("button", { name: "View" }).click();
  await sleep(1_200);
  await shot(page, "06-view-reopens-record.png");
  await sleep(600);
});

await record("signals", async page => {
  // The seeded ask is waiting: the pill carries a COUNT, not a dot.
  await page.waitForSelector(".fl-launcher-badge");
  await sleep(900);
  await shot(page, "10-badge-count.png");
  // Acting on it clears the count — the strip and the badge read one source.
  await page.locator(".fl-waiting-row").getByRole("button", { name: "Approve" }).click();
  await page.waitForSelector(".fl-launcher-badge", { state: "detached" });
  await sleep(900);
  await shot(page, "11-badge-cleared.png");
  // Now a run that finishes while the panel is closed: toast, then the dot.
  await page.getByRole("button", { name: "AI agent" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("How did my July spending go?");
  await page.getByRole("textbox", { name: "Message" }).press("Enter");
  await page.waitForSelector(".fl-ribbon");
  await page.getByRole("button", { name: "Close Vendo" }).click();
  await page.waitForSelector(".fl-launcher-toast");
  await sleep(500);
  // Ignore it: it withdraws and leaves the quiet dot.
  await page.waitForSelector(".fl-launcher-toast", { state: "detached", timeout: 15_000 });
  await sleep(700);
  await shot(page, "12-unseen-dot.png");
  await page.getByRole("button", { name: "AI agent" }).click();
  await sleep(900);
  await shot(page, "13-dot-cleared-on-open.png");
  await page.getByRole("button", { name: "Close Vendo" }).click();
  await sleep(800);
  await shot(page, "14-settled-no-signals.png");
});

console.log(`captured → ${OUT}`);
