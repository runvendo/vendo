import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/** 08-ui §4–5 — the ✦ menu's share toggle, in a real Chromium, over the
    localhost wire fixture. */
const SHOTS = "e2e/test-results";

test("the ✦ menu offers one named share, and it toggles", async ({ page }) => {
  await openScenario(page, "share-toggle");

  // The ✦ is a reveal: the pill is non-interactive until the app blooms it.
  const app = page.locator(".fl-slot-filled").first();
  await app.hover();
  await app.getByRole("button", { name: /^Edit / }).click();
  const toggle = page.getByRole("button", { name: "Share with Acme Corp" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // The order the person reads, top to bottom.
  await expect(page.locator(".fl-remix-menu button")).toHaveText([
    "Edit in chat", "Update", "Share with Acme Corp", "Revert",
  ]);
  await page.screenshot({ path: `${SHOTS}/share-toggle-off.png`, animations: "disabled" });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".fl-remix-menu")).toBeVisible();     // a switch, not a departure
  await page.screenshot({ path: `${SHOTS}/share-toggle-on.png`, animations: "disabled" });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
