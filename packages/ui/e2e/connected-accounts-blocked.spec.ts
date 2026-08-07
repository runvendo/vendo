import { expect, test } from "@playwright/test";
import { openScenario, parkRequest, screenshotPath } from "./helpers.js";

/**
 * The connected-accounts panel under a browser that refuses the sign-in window.
 *
 * `--block-new-web-contents` is the browser itself refusing every
 * `window.open` — exactly what a popup blocker or a hardened profile does, and
 * Chromium's headless shell ships no blocker of its own, so this is the only way
 * to reach that state. It is a LAUNCH argument, so this state needs its own
 * worker and therefore its own file (`test.use({ launchOptions })` cannot live
 * in a describe group).
 *
 * The panel passed no `onRedirect`, so a refused window left the person with a
 * spinner and no way to sign in — silence for the whole two-minute poll.
 */
test.use({ launchOptions: { args: ["--block-new-web-contents"] } });

test("a blocked sign-in window leaves a real link instead of silence", async ({ page }) => {
  // The status poll is parked so the moment the person actually lives in — the
  // connect in flight with nowhere to sign in — holds still.
  const release = await parkRequest(page, "**/connections/ca_new*");
  await openScenario(page, "accounts");
  await page.getByRole("button", { name: "Reconnect Notion" }).click();

  const notice = page.locator("[role=status].fl-connect-blocked");
  await expect(notice).toContainText("blocked the Notion sign-in window");
  const link = notice.getByRole("link", { name: "Open sign-in in a new tab" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://connect.test/oauth/1");
  await page.screenshot({ path: screenshotPath("accounts-popup-blocked"), fullPage: true, animations: "disabled" });
  release();
});
