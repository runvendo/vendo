import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// 0.4.4 cert defect B — a chat turn whose app build terminally failed streams
// a data-vendo-build-failed part and ends; the thread must render it as a
// visible error beat carrying the classified reason (the cert saw the turn
// spin for 10+ minutes and end with no trace).
test("the failed-build banner renders the classified reason in the thread", async ({ page }) => {
  await openScenario(page, "build-failed");
  const banner = page.locator("[data-vendo-build-failed]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Couldn't build the app");
  await expect(banner).toContainText("app build failed: generation failed");
  // The surrounding turn stays intact: the user ask and the pre-build text
  // both survive beside the banner.
  await expect(page.getByText("build me a small app that tracks invoice statuses")).toBeVisible();
  await expect(page.getByText("Building that for you now.")).toBeVisible();
  await page.screenshot({ path: screenshotPath("build-failed-banner"), fullPage: true, animations: "disabled" });
});
