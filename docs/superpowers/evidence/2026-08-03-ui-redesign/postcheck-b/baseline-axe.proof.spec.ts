/** BASELINE axe counts for the center, on redesign/final-cleanup (pre-Round-B). */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.use({ reducedMotion: "reduce" });

const axeOf = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include('[aria-label="Vendo workspace"]');

const summarize = (violations: { id: string; nodes: unknown[] }[]) =>
  violations.map(v => `${v.id} x${v.nodes.length}`).join(", ") || "none";

test("baseline desktop", async ({ page }) => {
  await page.goto("/page-chat");
  await expect(page.locator('[aria-label="Vendo workspace"]')).toBeVisible();
  await expect(page.getByRole("tab", { name: "Apps" })).toBeVisible();
  const home = await axeOf(page).analyze();
  await page.getByRole("tab", { name: "Apps" }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  const apps = await axeOf(page).analyze();
  console.log(`BASELINE desktop home: ${summarize(home.violations)}`);
  console.log(`BASELINE desktop apps: ${summarize(apps.violations)}`);
});

test("baseline 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/page-chat");
  await expect(page.locator('[aria-label="Vendo workspace"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Chats" })).toBeVisible();
  const closed = await axeOf(page).analyze();
  await page.getByRole("button", { name: "Chats" }).click();
  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
  await page.waitForTimeout(400);
  const open = await axeOf(page).analyze();
  console.log(`BASELINE 390 closed: ${summarize(closed.violations)}`);
  console.log(`BASELINE 390 sheet:  ${summarize(open.violations)}`);
});

/** The H11 probe: the harness's fixture apps render no interactive furniture, so
 *  axe had nothing to catch (ruling 17a — a blind fixture hides the class). A
 *  real generated view has buttons; inject one into each tile preview and ask
 *  axe again. */
test("baseline H11 probe: a focusable inside a tile preview", async ({ page }) => {
  await page.goto("/page");
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  const planted = await page.evaluate(() => {
    const previews = [...document.querySelectorAll(".fl-tile-view")];
    for (const preview of previews) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Pay now";
      preview.appendChild(button);
    }
    return {
      tiles: previews.length,
      hidden: previews.filter(node => node.getAttribute("aria-hidden") === "true").length,
      inert: previews.filter(node => node.hasAttribute("inert")).length,
      // Can the keyboard reach it? (inert refuses; aria-hidden does not.)
      reachable: previews.filter(node => {
        const button = node.querySelector("button")!;
        button.focus();
        return document.activeElement === button;
      }).length,
    };
  });
  const audit = await axeOf(page).analyze();
  console.log(`BASELINE H11 probe: ${JSON.stringify(planted)} → ${summarize(audit.violations)}`);
});
