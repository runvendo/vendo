import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// The consent register wears no badge. The in-chat approval card has been
// iconless for a while; the shield stayed on the standing-access card, the
// resolved card and the modal, so the same ask looked like two different
// products depending on where it was answered.
test("the standing-access card and the approval modal head with words alone", async ({ page }) => {
  await openScenario(page, "consent-marks");
  const card = page.locator("[data-vendo-grant-set-card]");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Standing access");
  await expect(card.locator(".fl-card-head .fl-card-ic")).toHaveCount(0);
  await expect(card.locator(".fl-card-head svg")).toHaveCount(0);

  await page.getByRole("button", { name: "Open the approval modal" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(page.locator(".fl-apmodal-mark")).toHaveCount(0);
  // The eyebrow is now the modal's first line, and it still has air above it.
  const eyebrow = modal.locator(".fl-apmodal-eyebrow");
  await expect(eyebrow).toBeVisible();
  const gap = await eyebrow.evaluate(node => {
    const dialog = node.closest(".fl-apmodal") as HTMLElement;
    return node.getBoundingClientRect().top - dialog.getBoundingClientRect().top;
  });
  expect(gap).toBeGreaterThan(16);
  await page.screenshot({ path: screenshotPath("consent-marks"), fullPage: true, animations: "disabled" });
});
