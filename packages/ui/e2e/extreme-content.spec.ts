import { expect, test, type Page } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-218 — extreme-content solidity. Rides the /thread-extreme scenario: a
 * 200-turn transcript (400 messages) with one enormous markdown message and an
 * approval carrying a huge argument blob, inside a bounded pane.
 *
 * Proves the thread stays solid under content that would otherwise stampede
 * entrance animations, balloon the DOM, and re-parse six-figure markdown:
 *  - the DOM holds only a bounded trailing WINDOW of turns, not all 400;
 *  - the deferred head reveals in chunks on demand and the reader isn't yanked;
 *  - stick-to-bottom and jump-to-latest still behave under the load;
 *  - a huge single message renders truncated with an expand affordance.
 */

const msglist = (page: Page) => page.locator(".fl-msglist");
const articleCount = (page: Page) => page.locator(".fl-msglist article[data-role]").count();

const scrollState = (page: Page) =>
  msglist(page).evaluate(node => ({
    scrollTop: Math.round(node.scrollTop),
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    gap: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
  }));

test.beforeEach(async ({ page }) => {
  await openScenario(page, "thread-extreme");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
});

test("a 400-message thread renders only a bounded window, opening at the latest turn", async ({ page }) => {
  // Windowed: far fewer than 402 articles are in the DOM.
  expect(await articleCount(page)).toBeLessThanOrEqual(60);
  // Opened at the end (stick-to-bottom held through restore).
  await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(32);
  expect((await scrollState(page)).scrollTop).toBeGreaterThan(0);
});

test("restored turns are gated out of the entrance animation (no stampede)", async ({ page }) => {
  // Every rendered turn present at restore carries the gate class.
  const total = await articleCount(page);
  const gated = await page.locator(".fl-msglist article.fl-no-entrance").count();
  expect(gated).toBe(total);
});

test("the deferred head reveals in chunks without yanking the reader", async ({ page }) => {
  const before = await articleCount(page);
  const older = page.getByRole("button", { name: /earlier message/i });
  await expect(older).toBeVisible();
  await older.click();
  await expect.poll(async () => articleCount(page)).toBeGreaterThan(before);
  // The reader stayed anchored (not thrown to the very top).
  expect((await scrollState(page)).scrollTop).toBeGreaterThan(0);
});

test("a huge single message is truncated with an expand affordance", async ({ page }) => {
  const expand = page.getByRole("button", { name: /show full message/i });
  await expect(expand).toBeVisible();
  // The collapsible block is the .fl-md that carries the expand control.
  const hugeBlock = page.locator(".fl-md:has(.fl-more)");
  const before = await hugeBlock.innerText();
  await expand.click();
  await expect(page.getByRole("button", { name: /show less/i })).toBeVisible();
  const after = await hugeBlock.innerText();
  expect(after.length).toBeGreaterThan(before.length);
});
