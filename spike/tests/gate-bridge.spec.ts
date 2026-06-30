import { test, expect } from "@playwright/test";

test("bridge: host ui/initialize reaches the runtime and is acknowledged", async ({ page }) => {
  await page.goto("/host.html");
  await expect(page.locator("#init-ack")).toHaveText("initialized");
});
