import { test, expect } from "@playwright/test";

test("gate 3: a scoped state value is projected in and rendered", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=state");
  const frame = page.frameLocator("#vendo-stage");
  await expect(frame.getByTestId("card-account")).toHaveText("Checking ****1234");
});
