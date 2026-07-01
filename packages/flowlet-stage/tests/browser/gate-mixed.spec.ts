import { test, expect } from "@playwright/test";

test("gate 8: prewired + host + generated nodes coexist in one stage", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=mixed");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("host-card")).toBeVisible(); // host
  await expect(frame.locator('[data-generated-impl="Badge2"]')).toBeVisible(); // generated component
  await expect(frame.locator("[data-prewired]")).toBeVisible(); // prewired primitive
});
