import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Regression for the demo-bank /vendo composition (VendoThread + VendoStage
 * mounted as siblings under one bounded, scrollable flex column — see
 * apps/demo-bank/src/app/vendo/page.tsx and docs/verification/
 * simplify-v2-wave2/README.md): at short viewport heights, once voice goes
 * active (VendoStage's consent bar + caption + feed rows claim real height
 * from the shared flex column), the in-conversation approval card's own
 * "bring the new approval into view" scroll used `block: "center"` — cropping
 * the card's Approve/Decline row off the bottom the instant the list became
 * shorter than the card itself, with no way to reach it. Root-caused via a
 * real-browser repro (not merely hypothesized): see approval-card.tsx.
 */

const shotPath = (name: string) =>
  new URL(`../../../docs/verification/simplify-v2-cleanup-batch/${name}.png`, import.meta.url).pathname;

test("voice widget never intercepts the approval card's buttons at short viewport heights", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 500 });
  await openScenario(page, "thread-voice-stack");

  const approveButton = page.getByRole("button", { name: "Approve" }).first();
  await expect(approveButton).toBeVisible();

  // Go active: this is what claims enough height from VendoStage's side of
  // the shared flex column to squeeze the thread pane below the approval
  // card's own height at this viewport.
  const startVoice = page.locator('button[aria-label="Start voice"], .fl-voice-foot button.fl-btn-primary');
  await startVoice.first().click();
  await expect(page.locator('.fl-voice-stage[data-state="listening"]')).toBeVisible();
  // The "bring the new approval into view" scroll fires 80ms after mount —
  // give it (and the smooth scrollIntoView animation it kicks off) time to
  // settle before asserting the final resting position.
  await page.waitForTimeout(1_000);

  await page.screenshot({ path: shotPath("after-01-short-viewport-active-voice"), animations: "disabled" });

  // The element actually hit-tested at the button's own center must be the
  // button itself (or a descendant) — not some other surface's box sitting on
  // top of it.
  const hitsSelf = await approveButton.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === node || (hit != null && node.contains(hit));
  });
  expect(hitsSelf, "the approval card's Approve button must receive the click, not an overlapping surface").toBe(true);
});
