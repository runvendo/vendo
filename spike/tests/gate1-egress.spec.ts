import { test, expect } from "@playwright/test";

test("gate 1b: network egress (fetch + image) is blocked by CSP", async ({ page }) => {
  await page.goto("/host.html");
  await expect(page.locator("#egress-fetch")).toHaveText("blocked");
  await expect(page.locator("#egress-img")).toHaveText("blocked");
});
