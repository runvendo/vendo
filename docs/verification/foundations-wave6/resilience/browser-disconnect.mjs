#!/usr/bin/env node
/**
 * Wave 6b beat D (ENG-239) — real-browser disconnect drill (the flagged
 * finding in 04-client-disconnect-transcript.txt).
 *
 * Drives the actual Maple UI in headless Chromium: logs in as the demo user,
 * sends a long chat turn, then disconnects mid-generation the way a person
 * would — closing the page or navigating away. Watch the provider-proxy log
 * (anthropic-passthrough-proxy.mjs) to see whether provider calls continue
 * after the disconnect. As captured on 2026-07-16 under `next dev`
 * (Next 16.2.9/Turbopack) they DO: graceful Chromium disconnects do not fire
 * `request.signal`, so the loop runs the turn to completion — unlike the
 * abrupt aborts in client-disconnect.mjs, which cancel within milliseconds.
 *
 * Run from a directory where `@playwright/test` resolves
 * (e.g. fixtures/integration-browser):
 *   node ../../docs/verification/foundations-wave6/resilience/browser-disconnect.mjs [page-close|browser-close|navigate-away]
 *
 * Assumes the dev server on localhost:3000 with the default demo password.
 */
import { chromium } from "@playwright/test";

const mode = process.argv[2] ?? "page-close";
const iso = () => new Date().toISOString();

const browser = await chromium.launch();
const page = await browser.newPage();

// Real Auth.js credentials login (yousef@maple.com is prefilled).
await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
await page.click('button[type="submit"]');
await page.waitForURL("http://localhost:3000/**", { waitUntil: "domcontentloaded" });
console.log(`[browser-drill] ${iso()} logged in`);

await page.goto("http://localhost:3000/vendo", { waitUntil: "networkidle" });
const composer = page.getByRole("textbox", { name: "Message" });
await composer.click();
// pressSequentially so the React composer enables its Send button.
await composer.pressSequentially(
  "Check my spending, budgets, and subscriptions, then give me a detailed month-by-month savings plan for a Kyoto trip.",
  { delay: 5 },
);
const postSeen = page.waitForResponse(
  (res) => res.url().includes("/api/vendo/threads") && res.request().method() === "POST",
  { timeout: 20000 },
);
// The composer's Send is the LAST one — the first is Maple's money-transfer button.
await page.getByRole("button", { name: "Send" }).last().click();
await postSeen;
console.log(`[browser-drill] ${iso()} turn streaming; waiting 8s into generation`);
await page.waitForTimeout(8000);
await page.screenshot({ path: "/tmp/browser-disconnect-moment.png" });
console.log(`[browser-drill] ${iso()} DISCONNECTING (${mode}) mid-generation`);
if (mode === "browser-close") {
  await browser.close();
} else if (mode === "navigate-away") {
  await page.goto("http://example.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(15000);
  await browser.close();
} else {
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 15000));
  await browser.close();
}
console.log(`[browser-drill] ${iso()} done — now check the provider-proxy log for post-disconnect calls`);
