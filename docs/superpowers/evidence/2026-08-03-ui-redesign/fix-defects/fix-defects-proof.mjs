/**
 * The fix-defects proof — the two build states the wave E2E caught wrong,
 * re-captured on a LIVE demo-bank (real Maple login, real Anthropic key, real
 * generation, real host tools), headless Chromium.
 *
 *   PORT=3222 node docs/superpowers/evidence/2026-08-03-ui-redesign/fix-defects/fix-defects-proof.mjs
 *
 * (a) MID-BUILD  — exactly ONE narration of the build step, and exactly ONE
 *     animating element (§8 A2 + D1).
 * (b) FAILED BUILD AT SETTLE — zero animating elements, no skeleton left in the
 *     thread or on the stage, and consumer-voiced prose (§8 build calm, §15,
 *     §16 law 3).
 *
 * Machine facts are read off the LIVE DOM the way the integration README does:
 * every `.vendo-root *` whose computed animation loops is listed by class.
 *
 * The failure state is not summonable on demand (the generation guard's honesty
 * checks reject roughly half of first attempts), so the failure ask is a prompt
 * in that class and the run RETRIES it until the runtime raises a real
 * `data-vendo-build-failed`. Nothing is scripted or stubbed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = here;
const PORT = process.env.PORT ?? "3222";
const BASE = `http://127.0.0.1:${PORT}/maple`;
const requireFromUi = createRequire(resolve(here, "../../../../../packages/ui/package.json"));
const { chromium } = requireFromUi("@playwright/test");

mkdirSync(OUT, { recursive: true });
const log = (...parts) => console.log("[fix]", ...parts);
const still = async (page, name) => {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  log("still", path);
};

async function until(page, label, fn, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() > deadline) {
      log("TIMEOUT waiting for", label);
      return false;
    }
    await page.waitForTimeout(300);
  }
}

/** Every element under the chrome root whose computed animation LOOPS — the
 *  same reading the integration README's "movingDuringBuild" used. */
const movingNow = () =>
  [...document.querySelectorAll(".vendo-root *")]
    .filter(node => {
      const style = getComputedStyle(node);
      return style.animationName !== "none" && style.animationName !== ""
        && style.animationIterationCount !== "1";
    })
    .map(node => (typeof node.className === "string" ? node.className : String(node.className)));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1_320, height: 860 }, deviceScaleFactor: 2 });
const page = await context.newPage();
// Next's dev error badge is dev-tool chrome, never shipped — hidden for the
// capture only. Nothing about Vendo is touched.
await context.addInitScript(() => {
  const style = document.createElement("style");
  style.textContent = "nextjs-portal{display:none!important}";
  document.addEventListener("DOMContentLoaded", () => document.head.append(style));
});
page.on("console", message => {
  if (message.type() === "error") log("page error:", message.text().slice(0, 160));
});

const facts = {};
try {
  log("login");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com");
  await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);

  await page.locator("button.fl-launcher").click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();

  const box = page.getByRole("textbox", { name: "Message" });

  /* ---- (a) MID-BUILD: one narration, one animating element -------------- */
  const ASK = "Where did my money go this month? Build me a spending breakdown I can keep";
  log("ask (a):", ASK);
  await box.fill(ASK);
  await box.press("Enter");

  facts.a_reachedBuild = await until(page, "the card's building bar",
    () => document.querySelector('.fl-appcard-bar[data-state="building"]') !== null, 180_000);
  // A `display: "stage"` build auto-opens the workspace, and the expand rides a
  // FLIP shared-element GHOST — a literal clone of the card, hairline included.
  // Measuring mid-flight counts the clone as a second animating element, so wait
  // for the flight to land: the ghost is transient chrome, not a build element.
  if (facts.a_reachedBuild) {
    await until(page, "the expand ghost to land",
      () => document.querySelector(".fl-embed-ghost") === null, 15_000);
  }
  if (facts.a_reachedBuild) {
    facts.a_movingDuringBuild = await page.evaluate(movingNow);
    facts.a_beatsDuringBuild = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    facts.a_barLabel = await page.evaluate(() =>
      document.querySelector('.fl-appcard-bar[data-state="building"] .fl-boot-building')?.textContent?.trim());
    facts.a_appBeats = facts.a_beatsDuringBuild.filter(text => /build an app/i.test(text ?? ""));
    log("(a) animating during build:", JSON.stringify(facts.a_movingDuringBuild));
    log("(a) beats during build:", JSON.stringify(facts.a_beatsDuringBuild));
    log("(a) build-step beats:", JSON.stringify(facts.a_appBeats));
    await still(page, "a-midbuild-one-narration-one-animation");
  }

  // Let the first turn finish so the second ask starts from a settled thread.
  await until(page, "the first turn to settle",
    () => document.querySelector(".fl-beatsummary") !== null
      || document.querySelector("[data-vendo-build-failed]") !== null, 300_000);

  /* ---- (b) A FAILED BUILD AT SETTLE ------------------------------------ */
  // The generation guard's honesty checks are what fail live (a percent column
  // bound to a raw cent integer, a goal that does not exist in the data). This
  // ask is squarely in that class; retried until the runtime raises a real
  // build failure.
  const FAULT_ASK = "Build me a table of every category's percentage share of my total spending"
    + " plus a progress bar toward my savings goal";
  for (let attempt = 1; attempt <= 4 && facts.b_failed !== true; attempt += 1) {
    log(`ask (b) attempt ${attempt}:`, FAULT_ASK);
    await box.fill(FAULT_ASK);
    await box.press("Enter");
    // Watch the failure land while the turn is still live so the settled read
    // below is the first settled frame.
    facts.b_failed = await until(page, "a real build failure",
      () => document.querySelectorAll("[data-vendo-build-failed]").length > 0, 300_000);
    if (facts.b_failed) break;
    await until(page, "the take to settle", () => document.querySelector(".fl-beatsummary") !== null, 120_000);
    await page.waitForTimeout(1_500);
  }

  if (facts.b_failed) {
    // The SETTLED frame: Stop is only mounted mid-turn, so its absence is the
    // turn being over — the exact moment §8 build calm is a claim about.
    facts.b_settled = await until(page, "the failed turn to settle",
      () => document.querySelector(".fl-stop") === null, 300_000);
    await page.waitForTimeout(1_200);
    facts.b_movingAtSettle = await page.evaluate(movingNow);
    facts.b_stillBuildingAtSettle = await page.evaluate(() => ({
      hairlines: document.querySelectorAll(".fl-boot-hairline").length,
      buildingBars: document.querySelectorAll('[data-state="building"]').length,
      appCards: document.querySelectorAll("[data-vendo-app-embed]").length,
      // The renderer's forming placeholders carry data-form-shape; the stage
      // shows its own empty line when no embed is featured.
      formingSkeletons: document.querySelectorAll("[data-form-shape]").length,
      stageOnSkeleton: document.querySelectorAll(".fl-stage [data-form-shape]").length,
      stageEmptyState: document.querySelectorAll(".fl-stage-empty").length,
    }));
    // Whatever app cards survive: what state each bar is in, and whether any of
    // them is still showing forming placeholders.
    facts.b_cardsAtSettle = await page.evaluate(() =>
      [...document.querySelectorAll("[data-vendo-app-embed]")].map(card => ({
        state: card.querySelector(".fl-appcard-bar")?.getAttribute("data-state"),
        label: card.querySelector('.fl-appcard-bar [aria-hidden="false"]')?.textContent?.trim(),
        formingPlaceholders: card.querySelectorAll("[data-form-shape]").length,
      })));
    facts.b_failureProse = await page.evaluate(() =>
      [...document.querySelectorAll("[data-vendo-build-failed]")].map(node => node.textContent?.trim()));
    facts.b_beatsAtSettle = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    facts.b_codeShapedInProse = facts.b_failureProse
      .flatMap(text => [/\w\(/, /[A-Za-z]\.[A-Za-z]/, /[A-Za-z]_[A-Za-z]/, /`/, /@[a-z-]+\//]
        .filter(pattern => pattern.test(text ?? ""))
        .map(pattern => `${pattern} in "${text}"`));
    log("(b) animating at settle:", JSON.stringify(facts.b_movingAtSettle));
    log("(b) still building at settle:", JSON.stringify(facts.b_stillBuildingAtSettle));
    log("(b) failure prose:", JSON.stringify(facts.b_failureProse));
    log("(b) code-shaped leaks:", JSON.stringify(facts.b_codeShapedInProse));
    log("(b) beats at settle:", JSON.stringify(facts.b_beatsAtSettle));
    log("(b) app cards at settle:", JSON.stringify(facts.b_cardsAtSettle));
    await still(page, "b-failed-build-settled-zero-animation");
    // The whole record, top to bottom — the failed turn has nowhere to hide a
    // leftover skeleton above the fold.
    await page.evaluate(() => { document.querySelector(".fl-msglist")?.scrollTo({ top: 0 }); });
    await page.waitForTimeout(600);
    await still(page, "c-whole-record-scrolled-to-top");
  }
} catch (error) {
  facts.error = error instanceof Error ? error.message : String(error);
  log("ERROR", facts.error);
  await still(page, "zz-error").catch(() => undefined);
} finally {
  writeFileSync(join(OUT, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`, "utf8");
  log("facts:", join(OUT, "facts.json"));
  await context.close();
  await browser.close();
}
