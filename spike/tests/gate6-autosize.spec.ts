import { test, expect } from "@playwright/test";

test("gate 6: iframe height tracks content and stabilizes", async ({ page }) => {
  await page.goto("/host.html?case=card");
  const iframe = page.locator("#flowlet-stage");
  await expect.poll(async () => Math.round((await iframe.boundingBox())!.height)).toBeGreaterThan(40);
  const h1 = (await iframe.boundingBox())!.height;
  await page.waitForTimeout(300);
  const h2 = (await iframe.boundingBox())!.height;
  expect(Math.abs(h1 - h2)).toBeLessThan(2); // stable, no oscillation
});
