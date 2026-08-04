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

/**
 * Spec §16 law 3, on the most public surface we have — the app embed renders
 * inside whatever chat page a HOST built. It used to print the wire's raw
 * build-failure `reason`, and every one of those sentences is written for
 * whoever can FIX the build. The wire fixture serves this scenario the exact
 * sentence the wave E2E photographed in a real user's thread (harness
 * vite.config.ts): a component name and an unevaluated expression.
 *
 * The audit is mechanical, over what the browser actually painted: nothing
 * code-shaped may be inside the embed, and no long word from the wire sentence
 * may survive anywhere on the page.
 */
test("a failed build shows the consumer sentence — nothing code-shaped reaches the embed", async ({ page }) => {
  await openScenario(page, "byo-embed-failed");

  const embed = page.locator('[data-vendo-embed="app"]');
  await expect(embed.locator(".fl-beat-error")).toBeVisible();
  await expect(embed.getByText("I couldn't finish building that view — nothing was changed."
    + " Ask again and I'll try a different approach.")).toBeVisible();
  // A copy fix, not a capability removal: the embed keeps its own affordance.
  await expect(embed.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.screenshot({ path: screenshotPath("byo-embed-failed") });

  const rendered = (await embed.innerText()).replace(/\s+/g, " ");
  const codeShaped: readonly [string, RegExp][] = [
    ["a backtick quote", /`/],
    ["call syntax", /\w+\(/],
    ["a dotted path", /\w\.\w+\.\w/],
    ["a snake_case identifier", /[A-Za-z]_[A-Za-z]/],
    ["a package specifier", /@[\w-]+\//],
    ["an npm command", /\bnpm\b/],
    ["a shouted env var", /\b[A-Z][A-Z0-9_]{4,}\b/],
  ];
  for (const [what, pattern] of codeShaped) {
    expect(pattern.test(rendered), `${what} reached the embed: ${rendered}`).toBe(false);
  }
  // Not one fragment of the developer sentence survives, anywhere on the page.
  const wholePage = await page.locator("body").innerText();
  for (const word of ["declarative", "JavaScript", "sum(spending.data.amount)", "DataTable", "expression"]) {
    expect(wholePage, `"${word}" leaked to the page`).not.toContain(word);
  }
});
