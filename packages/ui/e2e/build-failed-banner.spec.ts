import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// 0.4.4 cert defect B — a chat turn whose app build terminally failed streams
// a data-vendo-build-failed part and ends; the thread must render it as a
// visible error beat with what the failure MEANS for the reader (the cert saw
// the turn spin for 10+ minutes and end with no trace).
//
// The reason itself is what the reader gets. One canned sentence used to stand in
// front of it, which spoke as the agent and threw the actionable half away; the
// runtime's classified line ("timed out", "quota exhausted", a missing
// `@ai-sdk/*` package) is written to be read, so `buildFailureNotice`
// (chrome/thread/message-data.ts) passes it through verbatim. Only the wire
// marker comes off, because that is plumbing. The findings that quote the app's
// own code still stay in the server's `[vendo] app build failed (app_…)` line.
test("the failed-build banner tells the reader what happened, in their words", async ({ page }) => {
  await openScenario(page, "build-failed");
  const banner = page.locator("[data-vendo-build-failed]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Couldn't build the app");
  // The fixture's reason is "app build failed: generation failed" — the marker is
  // stripped, the classified half survives.
  await expect(banner).toContainText("generation failed");
  await expect(banner).not.toContainText("app build failed");
  // The surrounding turn stays intact: the user ask and the pre-build text
  // both survive beside the banner.
  await expect(page.getByText("build me a small app that tracks invoice statuses")).toBeVisible();
  await expect(page.getByText("Building that for you now.")).toBeVisible();
  await page.screenshot({ path: screenshotPath("build-failed-banner"), fullPage: true, animations: "disabled" });
});
