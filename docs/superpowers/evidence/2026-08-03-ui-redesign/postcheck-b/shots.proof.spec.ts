/** AFTER screenshots for the contrast pass (M33), on redesign/postcheck-b. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.use({ reducedMotion: "reduce" });
const OUT = "/Users/yousefh/orca/workspaces/flowlet/ui-s1-fixdefects/docs/superpowers/evidence/2026-08-03-ui-redesign/postcheck-b";

test("after: rail + open conversation + tiles", async ({ page }) => {
  await page.goto("/page-chat");
  await expect(page.locator('[aria-label="Vendo workspace"]')).toBeVisible();
  await page.waitForTimeout(500);
  await page.locator(".fl-rail").screenshot({ path: `${OUT}/b-m33-after-rail.png` });
  await page.getByRole("tab", { name: "Apps" }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/b-m33-after-apps-grid.png` });
});

test("after: mobile header + automations switch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/page-chat");
  await expect(page.locator('[aria-label="Vendo workspace"]')).toBeVisible();
  await page.getByRole("button", { name: "Apps" }).click();
  await page.waitForTimeout(400);
  await page.locator(".fl-center-head").screenshot({ path: `${OUT}/b-m33-after-mobile-head.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/automations");
  await expect(page.getByRole("switch").first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/b-m33-after-automations-switch.png` });
});

/** The H11 probe, mirrored from the baseline run: plant a focusable in every
 *  tile preview and ask both the browser and axe. */
test("after H11 probe: the planted focusable is refused and axe is clean", async ({ page }) => {
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
      reachable: previews.filter(node => {
        const button = node.querySelector("button")!;
        button.focus();
        return document.activeElement === button;
      }).length,
    };
  });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include('[aria-label="Vendo workspace"]')
    .analyze();
  const report = audit.violations.map(v => `${v.id} x${v.nodes.length}`).join(", ") || "none";
  console.log(`AFTER H11 probe: ${JSON.stringify(planted)} → ${report}`);
  expect(planted.tiles).toBeGreaterThan(0);
  expect(planted.inert).toBe(planted.tiles);
  expect(planted.hidden).toBe(0);
  expect(planted.reachable).toBe(0);
  expect(report).toBe("none");
});
