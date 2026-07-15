// Temporary ENG-229 DOM probe. NOT committed.
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto("http://localhost:3000/vendo", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
console.log("textareas:", await page.locator("textarea").count());
console.log("fl-thread:", await page.locator(".fl-thread").count());
console.log("fl-landing:", await page.locator(".fl-landing").count());
console.log("fl-voice-stage:", await page.locator(".fl-voice-stage").count());
const thread = page.locator(".fl-thread");
if (await thread.count()) console.log("thread text:", (await thread.first().textContent())?.slice(0, 300));
const body = await page.locator("body").innerText().catch(() => "");
console.log("body head:", body.slice(0, 400).replace(/\n+/g, " | "));
await browser.close();
