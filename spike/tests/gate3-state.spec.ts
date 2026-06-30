import { test, expect } from "@playwright/test";

test("gate 3: a scoped state value is projected in and rendered", async ({ page }) => {
  await page.goto("/host.html?case=state");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("card-account")).toHaveText("Checking ****1234");
});
