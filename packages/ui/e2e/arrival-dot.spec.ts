import { expect, test } from "@playwright/test";

/**
 * The arrival dot, in a real browser: it lights for an app nobody has looked at,
 * and it clears once the person's render lands — on the shared apps poll, with no
 * reload. Two defects met here. The reload was the first: the count used to be
 * computed once at the mount of whichever surface happened to list apps, so a dot
 * could neither appear nor go away while someone sat there. The second was that a
 * render IN THE THREAD never marked anything, so the dot survived the exact act
 * that should clear it — which is why the gesture below is opening the
 * conversation rather than mounting a slot.
 *
 * Full motion on purpose (the Maple host theme sets `motion: "full"`): the dot is
 * a painted mark on the pill, and the reduced-motion scenarios are the wrong
 * place to judge one.
 */
test("the launcher dot lights for an unseen app and clears after the thread render", async ({ page }) => {
  await page.goto("/arrival-dot");

  const launcher = page.locator(".fl-launcher");
  await expect(launcher).toBeVisible();

  // The pill carries the quiet dot, and no numbered badge: nothing is waiting on
  // a decision, something merely arrived.
  const dot = page.locator(".fl-launcher-dot");
  await expect(dot).toBeVisible();
  await expect(page.locator(".fl-launcher-badge")).toHaveCount(0);

  // The spoken half names neither half of what the dot can mean.
  await expect(launcher).toContainText("Something new to look at");

  await page.getByRole("button", { name: "Open the conversation" }).click();

  // No reload, no re-mount: the shared feed's next poll (5s) carries rows without
  // the flag and the dot withdraws on its own.
  await expect(dot).toHaveCount(0, { timeout: 15_000 });
  await expect(launcher).not.toContainText("Something new to look at");
});
