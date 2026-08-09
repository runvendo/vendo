import { expect, test } from "@playwright/test";
import { openScenario, parkRequest } from "./helpers.js";

/**
 * The connected-accounts panel's own connects, in a real browser.
 *
 * Both of them (Reconnect on a broken row, and a connect-ahead chip) called the
 * shared `completeConnection` with no window, which left it opening one AFTER
 * the initiate await — the post-await shape a popup blocker refuses. The click
 * did nothing. The other half of that defect (no fallback link when the browser
 * refuses the window anyway) needs a browser launched to refuse popups, which
 * Playwright only allows per worker — `connected-accounts-blocked.spec.ts`.
 *
 * Nothing here is stubbed: the panel talks to the real wire fixture and the
 * browser owns the window. `parkRequest` only holds a real request so an
 * in-flight moment stays still, then lets it through.
 */
test("Reconnect opens the sign-in window before the broker is asked", async ({ page, context }) => {
  // The broker request never answers while this runs, so a window can only
  // exist by having been opened inside the click itself.
  const release = await parkRequest(page, "**/connections/initiate");
  await openScenario(page, "accounts");
  const reconnect = page.getByRole("button", { name: "Reconnect Notion" });
  await expect(reconnect).toBeVisible();

  const signIn = context.waitForEvent("page");
  await reconnect.click();
  await expect(page.getByText("Reconnecting…")).toBeVisible();
  const window = await signIn;
  // Blank, and ours: the panel navigates this window to the broker's URL once
  // initiate answers and closes it from here when the account goes active —
  // never an unreachable background tab.
  expect(window.url()).toBe("about:blank");
  release();
});
