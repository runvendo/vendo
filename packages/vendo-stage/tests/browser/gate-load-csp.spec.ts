import { test, expect } from "@playwright/test";

test("gate 1a: stage iframe boots under a strict CSP and reports ready", async ({ page }) => {
  await page.goto("/fixtures/host.html");
  const frame = page.frameLocator("#vendo-stage");
  await expect(frame.locator("#stage-root")).toBeVisible();
  await expect(page.locator("#stage-status")).toHaveText("ready");
});
