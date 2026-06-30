import { test, expect } from "@playwright/test";

test("gate 1c+2: host bundle loads as data and renders with injected theme", async ({ page }) => {
  await page.goto("/host.html?case=card");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByTestId("host-card")).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Hello" })).toBeVisible();
  const color = await frame.getByRole("heading", { name: "Hello" }).evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe("rgb(0, 170, 119)"); // #00aa77 from --brand-primary
});
