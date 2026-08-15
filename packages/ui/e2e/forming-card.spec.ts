import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// The build's first seconds. `vendo_make` goes on the wire the moment a build
// starts and its beat is suppressed in favour of the app card — but that card
// only mounts on the first `data-vendo-view` part, so the whole window between
// the ask and the first view bytes rendered NOTHING build-specific. The card
// arrives empty instead, in the place the view will fill.
test("the app card stands in from the moment the build starts", async ({ page }) => {
  await openScenario(page, "thread-forming");
  const card = page.locator("[data-vendo-app-forming]");
  await expect(card).toBeVisible();
  await expect(card.locator(".fl-appcard-bar")).toHaveAttribute("data-state", "building");
  await expect(card).toContainText("Building your view");
  // Build calm (spec §8): the sweeping hairline is the one moving thing — the
  // silhouette under it rests.
  const hairline = card.locator(".fl-boot-hairline");
  await expect(hairline).toBeVisible();
  expect(await hairline.evaluate(node => getComputedStyle(node).animationName)).toBe("fl-boot-sweep");
  const skeleton = card.locator("[data-skeleton]");
  await expect(skeleton).toBeVisible();
  expect(await skeleton.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  // The ask and the assistant's own line still read above it.
  await expect(page.getByText("Build me a spending breakdown.")).toBeVisible();
  await page.screenshot({ path: screenshotPath("forming-card"), fullPage: true, animations: "disabled" });
});
