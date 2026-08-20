import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const SHOTS = "/tmp/remix-sparkle-gate";

/**
 * The ✦ is an OFFER, so it may only appear where sync could split the
 * component. Both cards on this page are wrapped in `<Remixable>`; only
 * `SpendCard` is named by the generated wiring.
 *
 * A real browser is the only proof of record here. The pill is revealed by
 * OPACITY under a real pointer, so jsdom can neither see the bloom nor tell an
 * invisible affordance from an absent one — and "absent" is the whole claim.
 */
test("the ✦ blooms on a ported component and does not exist on one that could not split", async ({ page }) => {
  await openScenario(page, "remixable-gate");

  const ported = page.locator('[data-vendo-remixable="SpendCard"]');
  const unported = page.locator('[data-vendo-remixable="LegacyCard"]');

  // Both host components render exactly the markup the host wrote.
  await expect(page.getByText("This one split.")).toBeVisible();
  await expect(page.getByText("This one did not split.")).toBeVisible();

  // The ported one carries the resting seed, and the cursor blooms it into the
  // pill. Opacity, not presence: the pill is in the DOM either way.
  const seed = ported.locator(".fl-remix-seed");
  const pill = ported.getByRole("button", { name: "Remix this view with Vendo" });
  await expect(seed).toHaveCount(1);
  await expect(pill).toHaveCSS("opacity", "0");
  // The bloom is a HANDOFF: the seed goes as the pill arrives, in one corner.
  await ported.hover();
  await expect(pill).toHaveCSS("opacity", "1");
  await expect(seed).toHaveCSS("opacity", "0");
  await page.screenshot({ path: `${SHOTS}/ported-blooms.png`, fullPage: true, animations: "disabled" });

  // The one that could not split carries no Vendo chrome AT ALL — not a hidden
  // ✦, not a disabled one, not a greyed one. Hovering it changes nothing.
  await unported.hover();
  // The reveal is per-wrapper, so the ported pill retracts once its own grace
  // period lapses — and this page then holds exactly one ✦, at rest.
  await expect(pill).toHaveCSS("opacity", "0");
  await expect(unported.locator(".fl-remixable-chrome")).toHaveCount(0);
  await expect(unported.locator(".fl-remix-seed")).toHaveCount(0);
  await expect(unported.getByRole("button", { name: "Remix this view with Vendo" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/unported-bare.png`, fullPage: true, animations: "disabled" });
});
