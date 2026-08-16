import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// A host's limits policy denies a request and the turn streams a
// `data-vendo-limit` part. The thread must show the cap being reached — in the
// host's own words when their policy wrote some, in the chrome's when it didn't
// — because the agent never ran to say it itself.
//
// A cap reached is not a failure: nothing broke, so the card stays in the
// beat's quiet register (no ✕, no danger colour) that the step-limit notice
// already established, and the conversation carries on past it.
test("the limit card says who set the cap, in their words or ours", async ({ page }) => {
  await openScenario(page, "limit");
  const cards = page.locator("[data-vendo-limit]");
  await expect(cards).toHaveCount(2);

  const hostSentence = cards.first();
  await expect(hostSentence).toBeVisible();
  await expect(hostSentence).toContainText("You’ve reached your limit");
  await expect(hostSentence).toContainText("You've used all 50 requests on the Free plan. Your allowance resets on the 1st.");
  await hostSentence.screenshot({ path: screenshotPath("limit-card-host-message"), animations: "disabled" });

  // The same card for a policy that returned no message: the chrome claims only
  // what it can know — the request never ran.
  const defaultCopy = cards.nth(1);
  await expect(defaultCopy).toContainText("You’ve reached your limit");
  await expect(defaultCopy).toContainText("This request wasn’t run — nothing was changed.");
  await defaultCopy.screenshot({ path: screenshotPath("limit-card-default"), animations: "disabled" });

  // Quiet, not loud: the failure register belongs to failures.
  await expect(cards.locator(".fl-beat-error")).toHaveCount(0);

  // The beat over the card names who refused — the host's rules. It read "you
  // declined it" directly above a card explaining the person had hit a limit:
  // the two lines contradicting each other about who said no.
  const beat = page.locator("[data-vendo-tool='vendo_make']");
  await expect(beat).toContainText("wasn't allowed");
  await expect(beat).not.toContainText("you declined it");
  await expect(beat).toHaveClass("fl-beat fl-beat-done");
  // The turn either side of the denials survives — the thread keeps going.
  await expect(page.getByText("build me a spending breakdown for last quarter")).toBeVisible();
  await expect(page.getByText("just a plain list of last month's charges then")).toBeVisible();
  await page.screenshot({ path: screenshotPath("limit-card-thread"), fullPage: true, animations: "disabled" });
});
