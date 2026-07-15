// Temporary ENG-229 Phase 3 browser verification driver — NOT committed.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const OUT = process.env.SHOT_DIR ?? "/tmp/eng229-shots";
fs.mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("shot:", name);
};

const status = (page) => page.locator(".fl-voice-status");

// Poll the stage until it reaches `target` (or error), printing progress.
const waitForState = async (page, target, seconds) => {
  for (let i = 0; i < seconds / 2; i += 1) {
    await page.waitForTimeout(2000);
    const state = await page.locator(".fl-voice-stage").getAttribute("data-state").catch(() => "?");
    if (i % 5 === 4) console.log(`  …waiting for ${target}, state=${state}`);
    if (state === target) return true;
    if (state === "error" && target !== "error") {
      console.log("  reached error instead:", await status(page).textContent().catch(() => "?"));
      return false;
    }
  }
  return false;
};

// Live connects can flake (upstream mint); retry once via the stage's own controls.
const connectLive = async (page, label) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retryBtn = page.getByRole("button", { name: "Retry" });
    const startBtn = page.getByRole("button", { name: "Start voice" });
    if (await retryBtn.count()) await retryBtn.click();
    else await startBtn.click();
    if (attempt === 1 && label) { await page.waitForTimeout(400); await shot(page, label); }
    if (await waitForState(page, "listening", 40)) return;
    console.log(`  connect attempt ${attempt} failed`);
  }
  throw new Error("could not reach listening after 3 attempts");
};

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("console-error:", m.text().slice(0, 200)); });

  await page.goto("http://localhost:3000/vendo", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".fl-voice-stage", { timeout: 20000 });
  await shot(page, "01-stage-idle");

  // --- live connect ---
  await connectLive(page, "02-connecting");
  await shot(page, "03-listening-live");
  console.log("state:", await page.locator(".fl-voice-stage").getAttribute("data-state"));

  // --- mute ---
  await page.getByRole("button", { name: "Mute" }).click();
  await page.waitForTimeout(300);
  await shot(page, "04-muted");
  await page.getByRole("button", { name: "Unmute" }).click();

  // --- drawer ---
  await page.getByRole("button", { name: "Transcript" }).click();
  await page.waitForSelector(".fl-voice-drawer");
  await shot(page, "05-drawer");
  await page.keyboard.press("Escape");

  // --- consent: raise a real approval through the live agent while voice is active ---
  let consentOk = false;
  try {
    const composer = page.getByPlaceholder("Ask anything");
    await composer.waitFor({ state: "visible", timeout: 20000 });
    await composer.fill("Send $50 to Jordan Avery from my checking account");
    await composer.press("Enter");
    await page.waitForSelector(".fl-voice-consent", { timeout: 90000 });
    await shot(page, "06-consent-live");
    const critical = await page.locator(".fl-voice-consent.is-critical").count();
    console.log("consent tier:", critical ? "critical" : "act/listening");
    await page.locator(".fl-voice-consent button", { hasText: "Decline" }).click();
    await page.waitForSelector(".fl-voice-consent.is-receipt", { timeout: 10000 });
    await shot(page, "07-receipt-declined");
    consentOk = true;
  } catch (error) {
    console.log("consent scenario failed:", String(error).slice(0, 300));
    await shot(page, "06-consent-FAILED");
  }

  // --- stop / settle ---
  await page.getByRole("button", { name: "Stop" }).click();
  await page.waitForTimeout(200);
  await shot(page, "08-leaving-settle");
  await page.waitForFunction(
    () => document.querySelector(".fl-voice-status")?.textContent === "Ready for voice",
    undefined,
    { timeout: 5000 },
  );
  await shot(page, "09-back-to-idle");

  // --- error + retry on a fresh page with a failing session mint ---
  const page2 = await ctx.newPage();
  let failMint = true;
  await page2.route("**/api/voice", async (route) => {
    if (failMint) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "voice backend unreachable" }) });
    else await route.continue();
  });
  await page2.goto("http://localhost:3000/vendo", { waitUntil: "domcontentloaded" });
  await page2.waitForSelector(".fl-voice-stage");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page2.getByRole("button", { name: "Start voice" }).click();
    await page2.waitForTimeout(2000);
    const state = await page2.locator(".fl-voice-stage").getAttribute("data-state");
    if (state !== "idle") break;
    console.log("  error-scenario start click swallowed (hydration), retrying");
  }
  await page2.waitForSelector(".fl-voice-banner[role=alert]", { timeout: 20000 });
  await shot(page2, "10-error-banner");
  failMint = false;
  await connectLive(page2, undefined);
  await shot(page2, "11-retry-recovered-live");

  await browser.close();
  console.log("DONE consentOk=" + consentOk);
};

run().catch((error) => { console.error("VERIFY FAILED:", error); process.exit(1); });
