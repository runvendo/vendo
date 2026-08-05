import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * §3.4 + §10.2 — the beat channel, in a real browser.
 *
 * No new scenario: `/overlay` already mounts the surface a heavy build is
 * watched in, and the beats ride the prompt the user types. The two frames a
 * person actually sees are the ones photographed here — the build in flight
 * with its accumulated dot-to-tick rail, and the settled turn that leaves
 * nothing behind.
 */
test("the workspace narrates a build as accumulating beats, then leaves nothing behind", async ({ page }) => {
  await openScenario(page, "overlay");
  await page.getByRole("button", { name: "Expand workspace" }).click();
  // The workspace flip is a real transition; photograph the settled layout, not
  // a half-faded frame.
  await expect(page.locator(".fl-split-stage")).toHaveCSS("opacity", "1");

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("[beats] build me a reconciliation workbench");
  await composer.press("Enter");

  const rail = page.locator(".fl-beatrail");
  await expect(rail.locator(".fl-beat")).toHaveCount(4);
  // Exactly one live beat, and every earlier line settled with a tick.
  await expect(rail.locator(".fl-beat.fl-beat-working")).toHaveCount(1);
  await expect(rail.locator(".fl-beat.fl-beat-done .fl-beat-tick")).toHaveCount(3);
  await expect(rail.locator(".fl-beat").last()).toContainText("Adding drag and drop");
  await expect(rail).toContainText("You can close this and keep working");
  // The between-steps ribbon speaks the same latest step, not "Working".
  const ribbon = page.locator(".fl-ribbon--working");
  await expect(ribbon).toContainText("Adding drag and drop");
  await page.screenshot({ path: screenshotPath("beats-midflight") });

  await expect(page.getByText("All done.")).toBeVisible({ timeout: 15_000 });
  // Ephemeral by construction: the settled turn narrates nothing, on either
  // surface. The transcript's own per-tool beat is the record that remains.
  await expect(rail).toHaveCount(0);
  await expect(ribbon).toHaveCount(0);
  await page.screenshot({ path: screenshotPath("beats-settled") });
});

/** Below the breakpoint the panel is a full-bleed takeover and the stage pane is
 *  display:none, so the composer ribbon is the ONLY beat narration a phone gets.
 *  It has to carry the real step there too — that is where most of the reach is. */
test("a phone narrates the latest beat on the ribbon, with no stage to fall back on", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScenario(page, "overlay");

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("[beats] build me a reconciliation workbench");
  await composer.press("Enter");

  await expect(page.locator(".fl-ribbon--working")).toContainText("Adding drag and drop");
  await expect(page.locator(".fl-beatrail")).toBeHidden();
  await page.screenshot({ path: screenshotPath("beats-mobile") });
});
