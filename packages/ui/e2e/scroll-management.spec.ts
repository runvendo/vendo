import { expect, test, type Page } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-213 — scroll management: stick-to-bottom + jump-to-latest.
 *
 * Rides the /thread-bounded scenario (bounded pane, ENG-212) and the wire
 * server's paced `[stream-long]` turn so every behavior is observed MID-stream
 * in a real browser: the list follows streamed content while the reader is at
 * the bottom, releases the moment they scroll up (no yanking), surfaces the
 * stylesheet's .fl-jump pill when unseen content lands, and re-sticks when the
 * pill is activated.
 */

const msglist = (page: Page) => page.locator(".fl-msglist");

const scrollState = (page: Page) =>
  msglist(page).evaluate(node => ({
    scrollTop: Math.round(node.scrollTop),
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    gap: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
  }));

test.beforeEach(async ({ page }) => {
  await openScenario(page, "thread-bounded");
  await expect(page.getByLabel("Approval for host_email_send")).toBeVisible();
});

test("a loaded long thread starts at the latest turn, not the top", async ({ page }) => {
  await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(32);
  const state = await scrollState(page);
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
  expect(state.scrollTop).toBeGreaterThan(0);
});

test("the list sticks to the bottom while a long turn streams", async ({ page }) => {
  await page.getByRole("textbox", { name: "Message" }).fill("[stream-long] narrate the whole month");
  await page.getByRole("button", { name: "Send" }).click();
  // Sample the stick mid-stream: content must be growing AND the reader held
  // at the bottom the whole way down.
  const first = await scrollState(page);
  await expect.poll(async () => (await scrollState(page)).scrollHeight, { timeout: 15000 })
    .toBeGreaterThan(first.scrollHeight + 200);
  const mid = await scrollState(page);
  expect(mid.gap, "list must follow streamed content while at the bottom").toBeLessThanOrEqual(32);
  await expect(page.getByText("Long turn complete.")).toBeVisible({ timeout: 30000 });
  const settled = await scrollState(page);
  expect(settled.gap).toBeLessThanOrEqual(32);
});

test("scrolling up mid-stream releases the stick and raises jump-to-latest; the pill re-sticks", async ({ page }) => {
  await page.getByRole("textbox", { name: "Message" }).fill("[stream-long] narrate the whole month");
  await page.getByRole("button", { name: "Send" }).click();
  // Wait only until the stream is visibly under way (a small threshold, so
  // plenty of stream remains even on a loaded worker)…
  const first = await scrollState(page);
  await expect.poll(async () => (await scrollState(page)).scrollHeight, { timeout: 15000 })
    .toBeGreaterThan(first.scrollHeight + 60);

  // …then the reader scrolls up to re-read history.
  await msglist(page).evaluate(node => { node.scrollTop = 0; });
  const parked = await scrollState(page);
  expect(parked.scrollTop).toBe(0);

  // No yanking: content keeps growing but the reader stays parked.
  await expect.poll(async () => (await scrollState(page)).scrollHeight, { timeout: 15000 })
    .toBeGreaterThan(parked.scrollHeight + 100);
  expect((await scrollState(page)).scrollTop, "streaming must never yank a reader who scrolled up").toBeLessThanOrEqual(1);

  // The unseen streamed content surfaces the pill; activating it re-sticks.
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(32);
  await expect(jump).toBeHidden();

  // Re-stuck: the rest of the stream keeps the reader pinned to the latest.
  await expect(page.getByText("Long turn complete.")).toBeVisible({ timeout: 30000 });
  expect((await scrollState(page)).gap).toBeLessThanOrEqual(32);
});

test("scrolling up without new content shows no pill", async ({ page }) => {
  await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(32);
  await msglist(page).evaluate(node => { node.scrollTop = 0; });
  await page.waitForTimeout(400);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();
});
