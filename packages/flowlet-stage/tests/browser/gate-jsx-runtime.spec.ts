import { test, expect } from "@playwright/test";
test("gate jsx-runtime: an automatic-runtime generated component (imports react/jsx-runtime) renders in the sandbox", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-jsx");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.locator('[data-generated-impl="JsxComp"]')).toBeVisible();
  await expect(frame.getByText("jsx works")).toBeVisible();
});
