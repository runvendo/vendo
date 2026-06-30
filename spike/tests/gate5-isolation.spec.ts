import { test, expect } from "@playwright/test";

test("gate 5: one throwing node does not take down the rest of the stage", async ({ page }) => {
  await page.goto("/host.html?case=throw");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("host-card")).toBeVisible();             // sibling survived
  await expect(frame.locator("[data-error-boundary]")).toHaveText(/render error/); // bad node contained
});
