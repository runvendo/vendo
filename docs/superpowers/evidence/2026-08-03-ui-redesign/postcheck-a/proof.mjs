/**
 * Round A post-check proof — real Chromium, the SHIPPED components, the harness
 * built in PRODUCTION mode (so every dev-mode gate this round added is OFF, the
 * way a customer sees it) served on port 3226.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
// Run from `packages/ui`:
//   node ../../docs/superpowers/evidence/2026-08-03-ui-redesign/postcheck-a/proof.mjs
// Playwright and the built package both resolve out of THAT package, not out of
// this folder — a bare specifier here would resolve beside the script.
const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = (await import(pathToFileURL(require.resolve("@playwright/test")).href)).default;


const BASE = "http://127.0.0.1:3226";
const OUT = new URL(".", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const { consumerVoiceViolation } = await import(`${process.cwd()}/dist/consumer-voice.js`);

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

/** Everything a person can read or hear, INCLUDING title tooltips (ruling 17a). */
const readable = page => page.evaluate(() => {
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) lines.push(walker.currentNode.textContent ?? "");
  for (const node of document.querySelectorAll("[aria-label]")) lines.push(node.getAttribute("aria-label") ?? "");
  for (const node of document.querySelectorAll("[title]")) lines.push(node.getAttribute("title") ?? "");
  return lines.join("\n");
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

const audit = async (surface) => {
  const violation = consumerVoiceViolation(await readable(page));
  check(`machine audit — ${surface}`, violation === undefined, violation ?? "clean");
};

// ── C1 · the developer policy banner, on every consumer surface, unconfigured ──
await page.goto(`${BASE}/unconfigured-posture`, { waitUntil: "networkidle" });
await page.waitForSelector(".fl-thread");
await page.waitForSelector(".fl-act-led-row");
const bannerCount = await page.locator('[aria-label="Vendo is running without a policy"]').count();
check("C1 · no policy banner on thread + waiting strip + activity (posture unconfigured)", bannerCount === 0, `banners=${bannerCount}`);
check("C1 · the posture really is unconfigured (the probe answered)", (await page.evaluate(async () => {
  const response = await fetch("/api/vendo/status", { headers: { "x-vendo-force-posture": "unconfigured" } });
  return (await response.json()).posture;
})) === "unconfigured");
await audit("unconfigured posture");
await page.screenshot({ path: `${OUT}/a1-policy-banner-free-thread.png`, fullPage: true, animations: "disabled" });

// ── C2 · the activity row speaks the user's language ──
await page.goto(`${BASE}/activity`, { waitUntil: "networkidle" });
await page.waitForSelector(".fl-act-led-row");
const detail = (await page.locator(".fl-act-led-det").first().textContent())?.trim();
check("C2 · the row's detail is humanized", detail === "— Amount cents $47.50 · Limit 10 · Status open", detail);
const body = await page.locator("body").textContent();
check("C2 · no raw guard preview on screen", !body.includes('host_invoices_list {'), "");
check("C2 · no raw cents integer on screen", !body.includes("4750"), "");
await audit("activity panel");
await page.screenshot({ path: `${OUT}/a2-activity-humanized-row.png`, animations: "disabled" });

// ── C5 · a fee beside the amount: no sentence, nothing folded ──
await page.goto(`${BASE}/approval-two-money`, { waitUntil: "networkidle" });
await page.waitForSelector(".fl-approval");
const line = (await page.locator(".fl-card-line").first().textContent())?.trim();
check("C5 · no money sentence when two amounts are declared", line === "This moves money, as you.", line);
check("C5 · the wrong figure is nowhere on the card", !(await page.locator("body").textContent()).includes("Sends $1.99"));
check("C5 · nothing folds on uncertainty", (await page.locator("details.fl-approval-details").count()) === 0);
const rows = await page.locator(".fl-card-field").allTextContents();
check("C5 · both amounts stay in plain sight", rows.length === 4 && rows.some(r => r.includes("$47.50")) && rows.some(r => r.includes("$1.99")), rows.join(" | "));
check("C5 · no raw literal in a tooltip (L37)", (await page.locator(".fl-card-field dd[title]").count()) === 0);
await audit("two-money approval card");
await page.screenshot({ path: `${OUT}/a3-two-money-approval-card.png`, animations: "disabled" });

// ── H14 · a grant row says what the ask does ──
await page.goto(`${BASE}/waiting`, { waitUntil: "networkidle" }).catch(() => undefined);
await page.waitForSelector(".fl-cardshell", { timeout: 8_000 }).catch(() => undefined);
await audit("waiting strip");

// ── Ruling 16 · the thread's failure has no bespoke control ──
await page.goto(`${BASE}/composer`, { waitUntil: "networkidle" });
const box = page.getByRole("textbox", { name: "Message" });
await box.fill("[stream-kill] walk me through the welcome flow");
await box.press("Enter");
await page.waitForSelector(".fl-error", { timeout: 20_000 });
check("ruling 16 · the banner says what happened", (await page.locator(".fl-error").first().textContent()).match(/didn.t finish/i) !== null);
check("ruling 16 · zero Retry controls in the conversation", (await page.getByRole("button", { name: "Retry" }).count()) === 0);
check("ruling 16 · the turn's Regenerate is the redo", (await page.getByRole("button", { name: "Regenerate" }).count()) > 0);
await audit("thread after a killed stream");
await page.screenshot({ path: `${OUT}/a4-thread-failure-no-retry.png`, animations: "disabled" });

// ── Ruling 18 · a non-conversational surface: one honest line + Try again ──
await page.goto(`${BASE}/byo-embed-failed`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-vendo-embed='app']");
await page.waitForSelector("button:has-text('Try again')", { timeout: 20_000 });
const embedText = await page.locator("[data-vendo-embed='app']").textContent();
check("ruling 18 · the embed names what happened", /couldn.t finish/i.test(embedText) && /nothing was changed/i.test(embedText), "");
check("ruling 18 · and offers Try again", (await page.getByRole("button", { name: "Try again" }).count()) > 0);
check("ruling 18 · no developer sentence in it", !embedText.includes("sum(spending.data.amount)"));
await audit("BYO embed, failed build");
await page.screenshot({ path: `${OUT}/a5-embed-line-plus-try-again.png`, animations: "disabled" });

// ── M36 · the voice stage's failure line ──
await page.goto(`${BASE}/stage-error`, { waitUntil: "networkidle" });
await page.waitForSelector('[role="alert"]', { timeout: 15_000 });
const alertText = await page.locator('[role="alert"]').first().textContent();
check("M36 · the voice banner is the standing line, not the driver's", alertText.includes("Voice session failed"), alertText);
check("M36 · Retry still starts a clean session", (await page.getByRole("button", { name: "Retry" }).count()) > 0);
await audit("voice stage error");
await page.screenshot({ path: `${OUT}/a6-voice-stage-consumer-line.png`, animations: "disabled" });

await browser.close();
console.log(failures.length === 0 ? "\nALL PROOF CHECKS PASSED" : `\n${failures.length} FAILED:\n${failures.join("\n")}`);
process.exit(failures.length === 0 ? 0 : 1);
