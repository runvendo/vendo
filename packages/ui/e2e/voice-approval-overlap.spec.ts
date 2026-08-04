import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Regression for the demo-bank /vendo composition (VendoThread + VendoStage
 * mounted as siblings under one bounded, scrollable flex column — see
 * examples/demo-bank/src/app/vendo/page.tsx and docs/verification/
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

test("squeezed idle voice stage never paints or intercepts outside its own box", async ({ page }) => {
  // The Maple /vendo repro at ~729px-tall DESKTOP viewports: the shared flex
  // column squeezes the IDLE stage toward zero height, but without overflow
  // clipping its foot (the Transcript button) kept painting past the stage
  // root's box over neighboring thread content — clicks on the lower half of
  // the in-thread Approve button landed on Transcript instead. Shrinking the
  // stack's bounded column reproduces the squeeze deterministically at
  // desktop width (no mobile approval-sheet takeover).
  await openScenario(page, "thread-voice-stack");
  const stack = page.locator(".fl-voice-root");
  await expect(stack).toBeVisible();
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".fl-voice-root");
    const pane = root?.parentElement;
    if (!pane) return;
    pane.style.height = "360px";
    // Content below the stage in the same column (Maple's pane keeps room
    // beneath it) — the zone the squeezed foot used to paint over.
    const below = document.createElement("div");
    below.dataset.testid = "below-stage";
    below.style.cssText = "height:80px; flex-shrink:0;";
    pane.append(below);
  });
  await page.waitForTimeout(400);

  // Nothing belonging to the voice stage may paint or hit-test OUTSIDE the
  // stage root's own flex box — a squeezed/collapsed stage must clip, not
  // overlay. Pinned with an escape probe: stage content laid out past the
  // root's bottom edge (exactly what the squeezed foot did) must be clipped
  // by the root, never clickable over whatever renders beyond it.
  const escaped = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".fl-voice-root");
    const stage = root?.querySelector<HTMLElement>(".fl-voice-stage");
    if (!root || !stage) return "missing stage";
    const probe = document.createElement("button");
    probe.textContent = "escape probe";
    probe.style.cssText = "position:absolute; left:0; right:0; top:100%; height:60px;";
    stage.append(probe);
    const rootRect = root.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rootRect.left + rootRect.width / 2,
      Math.min(rootRect.bottom + 20, window.innerHeight - 1),
    );
    const escapedHit = hit === probe;
    probe.remove();
    return escapedHit ? "stage content hit-tests below the root's box" : "clipped";
  });
  expect(escaped, "voice stage content must never hit-test outside the stage root's box").toBe("clipped");

  // And the in-thread Approve button stays fully clickable — top, center and
  // bottom edge all hit-test to the button itself once scrolled into view.
  const approveButton = page.getByRole("button", { name: "Approve" }).first();
  await approveButton.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  const deadSpots = await approveButton.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const misses: string[] = [];
    for (const frac of [0.1, 0.5, 0.9]) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * frac);
      if (hit !== node && (hit == null || !node.contains(hit))) {
        misses.push(`${frac}: ${(hit as HTMLElement | null)?.className ?? "none"}`);
      }
    }
    return misses;
  });
  expect(deadSpots, "every point on the Approve button must hit the button").toEqual([]);
});

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
