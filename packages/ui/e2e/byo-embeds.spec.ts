import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * Existing-agents polish — `VendoAppEmbed` in a BYO chat page.
 *
 * The wire's `app_island` app carries a model-realistic generated island: the
 * page sizes itself with viewport-height CSS in a `<style>` TAG. The jail
 * runtime normalizes inline viewport-height styles, but a stylesheet rule
 * escaped it — and inside an auto-sized iframe `100vh` means "the height the
 * host set last time", so any content after the full-height block ratchets
 * the frame taller every measure. Browser-observed on both examples' live
 * dashboards: the embed grows a tall run of empty background under the
 * content until the 8192px cap.
 */

test("a generated island with viewport-height stylesheet CSS fits its content (no tall empty space)", async ({ page }) => {
  await openScenario(page, "byo-embed-app");

  const jail = page.locator('[data-vendo-embed="app"] iframe[title^="Generated component"]');
  const island = page
    .frameLocator('[data-vendo-embed="app"] iframe[title^="Generated component"]')
    .frameLocator("iframe");
  await expect(island.getByRole("heading", { name: "City Weather Comparison" })).toBeVisible();
  await expect(island.getByRole("heading", { name: "Toronto" })).toBeVisible();

  // Let the resize pipeline settle, then measure twice: the frame must be
  // stable AND content-sized. Under the ratchet it blows past any sane bound
  // (three stat cards measure ~600px) on its way to the 8192px cap.
  await page.waitForTimeout(2_500);
  const first = await jail.evaluate(node => node.getBoundingClientRect().height);
  await page.waitForTimeout(1_200);
  const second = await jail.evaluate(node => node.getBoundingClientRect().height);
  // Viewport capture, not fullPage: stitched captures rasterize the nested
  // opaque-origin jail frame blank, which reads as a false regression.
  await page.getByTestId("after-embed").scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath("byo-embed-app") });

  expect(Math.abs(second - first), "island frame keeps growing").toBeLessThan(4);
  expect(second, "island frame is far taller than its content").toBeLessThan(900);
});

/**
 * The build window: `app_building_lands` misses its first open polls (the
 * wire fixture lands the build after two), and each miss used to log a
 * browser console 404. The embed now polls under the wire's `?pending=1`
 * flag — a miss is a quiet 200 envelope — so the whole window must produce
 * ZERO console errors while still resolving to the live app.
 */
test("the build window stays quiet: no console errors while the embed polls a not-yet-servable app", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", message => {
    // The harness ships no favicon; that 404 is the page's, not the embed's.
    if (message.type() === "error" && !message.text().includes("favicon")) errors.push(message.text());
  });
  page.on("pageerror", error => errors.push(String(error)));

  await openScenario(page, "byo-embed-building");
  await expect(page.locator('.fl-appcard-bar[data-state="building"]')).toBeVisible();
  await expect(page.locator('.fl-appcard-bar[data-state="ready"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Trip planner app surface")).toBeVisible();
  await page.screenshot({ path: screenshotPath("byo-embed-building") });

  expect(errors).toEqual([]);
});
