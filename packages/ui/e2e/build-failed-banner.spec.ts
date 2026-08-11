import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// 0.4.4 cert defect B — a chat turn whose app build terminally failed streams
// a data-vendo-build-failed part and ends; the thread must render it as a
// visible error beat with what the failure MEANS for the reader (the cert saw
// the turn spin for 10+ minutes and end with no trace).
//
// This spec was red on redesign/final-cleanup and in no CI job, which is why
// nobody saw it: it still demanded the WIRE's reason on screen ("app build
// failed: generation failed"). §16 law 3 moved that sentence to the server's own
// log and put BUILD_FAILURE_COPY in front of the person, so the assertion is now
// the other way round — the developer's sentence must NOT be here.
test("the failed-build banner tells the reader what happened, in their words", async ({ page }) => {
  await openScenario(page, "build-failed");
  const banner = page.locator("[data-vendo-build-failed]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Couldn't build the app");
  await expect(banner).toContainText("nothing was changed");
  await expect(banner).not.toContainText("app build failed");
  await expect(banner).not.toContainText("generation failed");
  // The surrounding turn stays intact: the user ask and the pre-build text
  // both survive beside the banner.
  await expect(page.getByText("build me a small app that tracks invoice statuses")).toBeVisible();
  await expect(page.getByText("Building that for you now.")).toBeVisible();
  await page.screenshot({ path: screenshotPath("build-failed-banner"), fullPage: true, animations: "disabled" });
});
