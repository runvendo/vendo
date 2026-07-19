import { expect, test, type Page } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-218 — verification captures (committed to docs/verification/eng-218/).
 * Not a behavioral gate (that is extreme-content.spec.ts + scroll-management.spec.ts);
 * this spec produces the PR screenshots and prints the rendered-node perf metric.
 */

const shotPath = (name: string) =>
  new URL(`../../../docs/verification/eng-218/${name}.png`, import.meta.url).pathname;

const nodeStats = (page: Page) =>
  page.locator(".fl-msglist").evaluate(node => ({
    articles: node.querySelectorAll("article[data-role]").length,
    domNodes: node.querySelectorAll("*").length,
  }));

test("long thread — windowed, opened at latest", async ({ page }) => {
  await openScenario(page, "thread-extreme");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  const stats = await nodeStats(page);
  // 200 turns + huge message + pending = 402 messages in the transcript.
  console.log(`[ENG-218] extreme thread: ${stats.articles} articles / ${stats.domNodes} DOM nodes rendered (of 402 messages)`);
  expect(stats.articles).toBeLessThanOrEqual(60);
  await page.screenshot({ path: shotPath("01-long-thread-windowed"), fullPage: false, animations: "disabled" });
});

test("long thread — 'earlier messages' reveals the deferred head", async ({ page }) => {
  await openScenario(page, "thread-extreme");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.locator(".fl-msglist").evaluate(node => { node.scrollTop = 0; });
  const older = page.getByRole("button", { name: /earlier message/i });
  await expect(older).toBeVisible();
  await page.screenshot({ path: shotPath("02-earlier-messages-control"), fullPage: false, animations: "disabled" });
  await older.click();
  await expect.poll(async () => (await nodeStats(page)).articles).toBeGreaterThan(0);
});

test("huge message — collapsed then expanded", async ({ page }) => {
  await openScenario(page, "thread-extreme");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  const expand = page.getByRole("button", { name: /show full message/i });
  // Bring the collapsed huge block into view.
  await expand.scrollIntoViewIfNeeded();
  await expect(expand).toBeVisible();
  await page.screenshot({ path: shotPath("03-huge-message-collapsed"), fullPage: false, animations: "disabled" });
  await expand.click();
  await expect(page.getByRole("button", { name: /show less/i })).toBeVisible();
  await page.getByRole("button", { name: /show less/i }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: shotPath("04-huge-message-expanded"), fullPage: false, animations: "disabled" });
});

test("jump-to-latest under streaming load", async ({ page }) => {
  await openScenario(page, "thread-bounded");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("[stream-long] narrate the whole month");
  await page.getByRole("button", { name: "Send" }).click();
  const list = page.locator(".fl-msglist");
  const first = await list.evaluate(node => node.scrollHeight);
  await expect.poll(async () => list.evaluate(node => node.scrollHeight), { timeout: 15000 })
    .toBeGreaterThan(first + 60);
  // Reader scrolls up mid-stream; the new-replies bar (lane pick 3A) surfaces
  // as new content lands.
  await list.evaluate(node => { node.scrollTop = 0; });
  const jump = page.locator(".fl-newbar");
  await expect(jump).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: shotPath("05-jump-to-latest-under-load"), fullPage: false, animations: "disabled" });
  await jump.click();
  await expect.poll(async () =>
    list.evaluate(node => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight)),
  ).toBeLessThanOrEqual(32);
});
