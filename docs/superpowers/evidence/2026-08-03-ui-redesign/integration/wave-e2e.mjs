/**
 * The WAVE E2E (plan I2) — ONE continuous run through everything the redesign
 * changed, against a LIVE demo-bank (real Maple login, real Anthropic key, real
 * generation). Headless Chromium, recorded, converted to `wave.gif` +
 * numbered stills beside it.
 *
 *   PORT=3220 node docs/superpowers/evidence/2026-08-03-ui-redesign/integration/wave-e2e.mjs
 *
 * The one deliberately non-live segment is the FAULT PATH: a real upstream
 * failure is not summonable on demand, so it is captured through the shipped
 * director mode (ScriptedTransport) exactly as lane C did — noted in the README.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { videoToGif } from "../../../../../scripts/capture-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = here;
const PORT = process.env.PORT ?? "3220";
// Maple is served in place under a basePath (src/lib/base-path.ts).
const BASE = `http://127.0.0.1:${PORT}/maple`;
const requireFromUi = createRequire(resolve(here, "../../../../../packages/ui/package.json"));
const { chromium } = requireFromUi("@playwright/test");

mkdirSync(OUT, { recursive: true });

const log = (...parts) => console.log("[wave]", ...parts);
let shot = 0;
const still = async (page, name) => {
  shot += 1;
  const path = join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  log("still", path);
};

/** Poll a DOM predicate; returns false on timeout instead of throwing, so one
 *  soft beat never loses the whole recording. */
async function until(page, label, fn, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() > deadline) {
      log("TIMEOUT waiting for", label);
      return false;
    }
    await page.waitForTimeout(400);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1_320, height: 860 },
  deviceScaleFactor: 2,
  recordVideo: { dir: join(OUT, ".video"), size: { width: 1_320, height: 860 } },
});
const page = await context.newPage();
// The Next dev server paints its own error-overlay badge into <nextjs-portal>.
// That is DEV-TOOL chrome, never shipped, and it must not sit in a product
// proof frame — hidden for the capture only, nothing about Vendo is touched.
await context.addInitScript(() => {
  const style = document.createElement("style");
  style.textContent = "nextjs-portal{display:none!important}";
  document.addEventListener("DOMContentLoaded", () => document.head.append(style));
});
page.on("console", message => {
  if (message.type() === "error") log("page error:", message.text().slice(0, 200));
});

const facts = {};
try {
  // ---- 1. cold-ish start: real Maple login -------------------------------
  log("login");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com");
  await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await still(page, "maple-home");

  // ---- 2. the first ask: live generation ---------------------------------
  log("open the panel");
  // Maple's transaction rows carry their own "Ask Maple about <merchant>"
  // buttons, so the pill is addressed by its class, not by name.
  const launcher = page.locator("button.fl-launcher");
  await launcher.click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();
  await still(page, "panel-open");

  const ASK = "Where did my money go this month? Build me a spending breakdown I can keep";
  log("ask:", ASK);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(ASK);
  await box.press("Enter");

  // Beats tick in the transcript (spec §1).
  facts.beats = await until(page, "a beat in the transcript",
    () => document.querySelectorAll(".fl-beat").length > 0, 90_000);
  if (facts.beats) await still(page, "beats-working");

  // Build calm (spec §8): while a build runs, the hairline is the ONLY animation.
  facts.buildCalm = await until(page, "the build state", () => {
    const building = document.querySelector('[data-state="building"]');
    if (!building) return false;
    const moving = [...document.querySelectorAll(".vendo-root *")].filter(node => {
      const name = getComputedStyle(node).animationName;
      return name !== "none" && name !== "" && getComputedStyle(node).animationIterationCount !== "1";
    }).map(node => node.className);
    window.__vendoMoving = moving;
    return true;
  }, 90_000);
  if (facts.buildCalm) {
    facts.movingDuringBuild = await page.evaluate(() => window.__vendoMoving ?? []);
    log("animating during build:", JSON.stringify(facts.movingDuringBuild));
    // spec §8 D1 — the build narrates ONCE. Record what the transcript says at
    // this instant so a double-narration cannot hide in a GIF.
    facts.beatsDuringBuild = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    log("beats during build:", JSON.stringify(facts.beatsDuringBuild));
    await still(page, "build-hairline");
  }

  // The card lands. `display: "stage"` (lane E) should auto-open the split.
  facts.card = await until(page, "the app card",
    () => document.querySelector("[data-vendo-app-embed], .fl-appcard") !== null, 240_000);
  facts.staged = await page.evaluate(() => document.querySelector(".fl-split, [data-vendo-split]") !== null);
  log("card:", facts.card, "staged:", facts.staged);
  if (facts.card) await still(page, "app-card-landed");

  // The settled turn folds into one row (spec §1 C2).
  facts.summary = await until(page, "the settled summary row",
    () => document.querySelector(".fl-beatsummary") !== null, 120_000);
  if (facts.summary) {
    facts.summaryText = await page.evaluate(() =>
      document.querySelector(".fl-beatsummary")?.textContent?.trim() ?? "");
    log("summary row:", facts.summaryText);
    facts.beatsAtSettle = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    log("beats visible at settle:", JSON.stringify(facts.beatsAtSettle));
    // §8 build-calm is a claim about the SETTLED turn too: nothing may still be
    // sweeping once the turn is over, on the stage or in the rail.
    facts.stillBuildingAtSettle = await page.evaluate(() => ({
      hairlines: document.querySelectorAll(".fl-boot-hairline").length,
      buildingBars: [...document.querySelectorAll('[data-state="building"]')].length,
    }));
    log("still building at settle:", JSON.stringify(facts.stillBuildingAtSettle));
    await still(page, "turn-folded");
    await page.locator(".fl-beatsummary").first().click();
    await still(page, "turn-reopened");
    await page.locator(".fl-beatsummary").first().click();
  }

  // ---- 3. close the panel mid-run (spec §2 G1) ---------------------------
  log("second ask, then close mid-run");
  await box.fill("Now list my three biggest merchants this month and what I spent at each");
  await box.press("Enter");
  await until(page, "the second turn to start working",
    () => document.querySelector(".fl-beat, .fl-ribbon") !== null, 60_000);
  await page.getByRole("button", { name: "Close Vendo" }).click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor({ state: "hidden" });
  await still(page, "panel-closed-mid-run");

  facts.pillProgress = await until(page, "the pill's live ring + beat",
    () => document.querySelector(".fl-launcher-ring") !== null, 90_000);
  if (facts.pillProgress) {
    facts.pillLabel = await page.evaluate(() =>
      document.querySelector(".fl-launcher-beat")?.textContent?.trim() ?? "");
    log("pill narrates:", facts.pillLabel);
    await still(page, "pill-narrates");
  }

  facts.toast = await until(page, "the completion toast",
    () => document.querySelector(".fl-launcher-toast") !== null, 240_000);
  if (facts.toast) {
    facts.toastHead = await page.evaluate(() =>
      document.querySelector(".fl-launcher-toast-head")?.textContent?.trim() ?? "");
    log("toast:", facts.toastHead);
    await still(page, "completion-toast");
    // View deep-links back into the SAME surface it was raised on (§13).
    await page.locator(".fl-launcher-toast").getByRole("button", { name: "View" }).click();
    await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();
    await still(page, "reopened-record");
    await page.getByRole("button", { name: "Close Vendo" }).click();
  }

  // ---- 4. a live approval: pending → Approve → settled (spec §16) --------
  log("live approval");
  await launcher.click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();
  await box.fill("Send $47.50 to Acme Utilities from my checking account for the July water bill");
  await box.press("Enter");
  facts.approvalCard = await until(page, "the approval card",
    () => document.querySelector(".fl-cardshell.fl-approval") !== null, 180_000);
  if (facts.approvalCard) {
    facts.approvalRows = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-cardshell.fl-approval .fl-card-field")].map(row => [
        row.querySelector("dt")?.textContent?.trim(),
        row.querySelector("dd")?.textContent?.trim(),
      ]));
    facts.approvalEyebrow = await page.evaluate(() =>
      document.querySelector(".fl-cardshell.fl-approval .fl-card-eyebrow")?.textContent?.trim() ?? "");
    facts.approvalLine = await page.evaluate(() =>
      document.querySelector(".fl-cardshell.fl-approval .fl-card-line")?.textContent?.trim() ?? "");
    facts.approvalByline = await page.evaluate(() =>
      document.querySelector(".fl-cardshell.fl-approval .fl-card-byline")?.textContent?.trim() ?? "");
    log("approval rows:", JSON.stringify(facts.approvalRows));
    log("eyebrow:", facts.approvalEyebrow, "| line:", facts.approvalLine, "| byline:", facts.approvalByline);
    await still(page, "approval-pending");
    const approve = page.locator(".fl-cardshell.fl-approval").getByRole("button", { name: /^Approve/ }).first();
    if (await approve.count() > 0) {
      await approve.click();
      // ENG-205 — the approved card LIFTS into the top-right morph toast as the
      // run resumes underneath it. The toast is transient, so grab it fast.
      facts.morphToast = await until(page, "the ENG-205 morph toast",
        () => document.querySelector(".fl-morph-card") !== null, 8_000);
      if (facts.morphToast) await still(page, "approval-morphing");
      // SETTLED, as spec §3 defines it: the ask is gone from the thread and the
      // turn resumed with the agent's own record of what it did.
      facts.approvalSettled = await until(page, "the ask to clear and the turn to resume", () => {
        const askGone = document.querySelector(".fl-cardshell.fl-approval") === null;
        const resumed = /sent|transferred|moved|done/i.test(document.querySelector(".fl-msglist")?.textContent ?? "");
        return askGone && resumed;
      }, 120_000);
      facts.approvalOutcome = await page.evaluate(() => {
        const turns = [...document.querySelectorAll(".fl-turn-assistant, .fl-msg-assistant")];
        return turns.at(-1)?.textContent?.trim().slice(0, 220) ?? "";
      });
      log("settled:", facts.approvalSettled, "| outcome:", facts.approvalOutcome);
      await still(page, "approval-settled");
    } else {
      log("no Approve button on the card");
    }
  }
  // A second money ask, deliberately LEFT PENDING: §4's numbered badge and the
  // center's Needs-you section only exist while an ask is actually waiting.
  log("leave one ask pending");
  await box.fill("Move $200 from my checking account to savings.");
  await box.press("Enter");
  facts.secondAskPending = await until(page, "a second pending ask",
    () => document.querySelector(".fl-cardshell.fl-approval") !== null, 180_000);
  await still(page, "second-ask-pending");
  await page.getByRole("button", { name: "Close Vendo" }).click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor({ state: "hidden" });
  facts.launcherBadge = await page.evaluate(() =>
    document.querySelector(".fl-launcher-badge")?.textContent?.trim() ?? "");
  log("launcher badge:", facts.launcherBadge);
  await still(page, "launcher-badge");

  // ---- 5. the center page walk (spec §10 X1, §12) ------------------------
  log("center walk");
  await page.goto(`${BASE}/vendo/workspace`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  facts.center = await until(page, "the center rail",
    () => document.querySelector(".fl-center, .fl-rail-group, .fl-rail-row") !== null, 60_000);
  await still(page, "center-home");
  facts.centerRail = await page.evaluate(() => ({
    // §12 law: a PAGE inside the host app — no brand row, no user row.
    brandRow: document.querySelector(".fl-rail-brand") !== null,
    userRow: document.querySelector(".fl-rail-user") !== null,
    doors: [...document.querySelectorAll(".fl-rail-row")].map(node => node.textContent?.trim()),
    chats: document.querySelectorAll(".fl-rail-chat:not(.fl-rail-need)").length,
    needsYou: document.querySelector(".fl-rail-need") !== null,
  }));
  log("rail:", JSON.stringify(facts.centerRail));

  for (const door of ["Apps", "Automations"]) {
    // The rail's doors are a vertical tablist (role=tab), not plain buttons.
    const row = page.getByRole("tab", { name: door, exact: true }).first();
    if (await row.count() > 0) {
      await row.click();
      await page.waitForTimeout(900);
      await still(page, `center-${door.toLowerCase()}`);
    } else {
      log("no", door, "door found");
    }
  }
  if (facts.centerRail.needsYou) {
    await page.locator(".fl-rail-need").first().click();
    await page.waitForTimeout(700);
    await still(page, "center-needs-you");
  }

  facts.ok = true;
} catch (reason) {
  facts.ok = false;
  facts.failure = reason instanceof Error ? reason.message : String(reason);
  log("FAILED:", facts.failure);
  await still(page, "failure-state").catch(() => undefined);
} finally {
  await context.close();
  await browser.close();
}

const { gif } = await videoToGif(join(OUT, ".video"), join(OUT, "wave.gif"), { fps: 10, width: 1_000 });
log("gif:", gif);
console.log("FACTS " + JSON.stringify(facts));
