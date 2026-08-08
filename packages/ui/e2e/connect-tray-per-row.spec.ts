import { expect, test } from "@playwright/test";
import { openScenario, parkRequest, screenshotPath } from "./helpers.js";

/**
 * The connect tray's in-flight state, measured the way the browser pass measured
 * it: count the add buttons, and count how many of them the browser will refuse
 * to click.
 *
 * The tray held ONE `connecting` toolkit for the whole surface and disabled every
 * add button off it, so starting a single connect made every other connector
 * inert for the full 120s poll — no cancel, and no disabled styling to say why
 * (`{spinners: 1, disabledAdds: 55, totalAdds: 55}` on Maple's 56-toolkit
 * catalog). #1051 gave the connected-accounts panel per-key state; the tray is
 * the second caller that never got it.
 *
 * `parkRequest` fakes nothing — it holds the REAL initiate open so the in-flight
 * moment stays still long enough to photograph and count.
 */
test("one connect in flight leaves every other connector clickable", async ({ page }) => {
  const release = await parkRequest(page, "**/connections/initiate");
  await openScenario(page, "affordances");
  await page.getByRole("button", { name: "Connect tools" }).click();
  const tray = page.locator(".fl-tray");
  await expect(tray).toBeVisible();

  await tray.getByRole("button", { name: "Connect Slack" }).click();
  await expect(tray.getByRole("status", { name: "Connecting Slack" })).toBeVisible();

  const counted = await tray.evaluate(node => {
    const adds = [...node.querySelectorAll<HTMLButtonElement>("button.fl-picker-add")];
    return {
      spinners: node.querySelectorAll(".fl-picker-connecting").length,
      disabledAdds: adds.filter(button => button.disabled).length,
      totalAdds: adds.length,
    };
  });
  // Photographed before it is judged, so a failing run leaves the reproduction
  // behind rather than only an assertion message.
  await page.screenshot({ path: screenshotPath("connect-tray-in-flight"), animations: "disabled" });
  // The connecting row renders its dots INSTEAD of a button, so the add buttons
  // still on screen ARE the other connectors — and none of them is disabled.
  expect(counted).toEqual({ spinners: 1, disabledAdds: 0, totalAdds: 1 });

  // Still live, not merely styled as such: a second connect starts and keeps its
  // own dots beside the first.
  await tray.getByRole("button", { name: "Connect QuickBooks" }).click();
  await expect(tray.getByRole("status", { name: "Connecting QuickBooks" })).toBeVisible();
  await expect(tray.getByRole("status", { name: "Connecting Slack" })).toBeVisible();
  // The only VISIBLE difference this fix makes. A tray with one shared
  // `connecting` looked identical to a working one — the 55 inert buttons carried
  // no disabled styling at all — so two rows connecting at once is the state a
  // screenshot can actually tell apart from the old behaviour.
  await page.screenshot({ path: screenshotPath("connect-tray-two-in-flight"), animations: "disabled" });
  release();
});
