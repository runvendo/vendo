import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * A failed slot has to say what happened AT REST, in whatever box the host gave
 * it — `--fl-slot-min-h` is the knob chrome-css ships for a host to size its own
 * slot, and a classified build reason is real prose, so the two together are the
 * ordinary case rather than the extreme one.
 *
 * The card that failed this was the one already covered: `.fl-slot-cta` is
 * absolutely positioned, so it contributes NO height, and the ghost's
 * `overflow: hidden` then sliced the headline off the top and the ways out off
 * the bottom, leaving a bare paragraph nobody could act on. `toBeVisible()`
 * cannot see that — Playwright calls a clipped element visible — so this asks
 * the only question that settles it: is each part painted inside the box that
 * clips it?
 */
test("a failed card keeps its headline and its ways out in a host-sized slot", async ({ page }) => {
  await openScenario(page, "slot-states");
  const slot = page.locator('[data-vendo-slot="slot-failed"]');
  // The card paints TWICE: the headline and "Clear this slot" at once, then the
  // classified reason and "Try again" when the one detail read answers. Both the
  // clip and the measurement below are about the settled card — the first paint
  // carries the short generic line, which fits — so anchor on the only thing
  // that read puts on screen, and let the suite's own expect budget do the wait.
  await expect(slot.getByRole("button", { name: "Try again" })).toBeVisible();

  // A host that lets a rail-width slot size itself — the reason then wraps to
  // more lines than the card is tall, which is the whole of the bug.
  await page.addStyleTag({
    content: '[data-vendo-slot="slot-failed"] { max-width: 320px; --fl-slot-min-h: 0; }',
  });

  const painted = await slot.evaluate(node => {
    const card = node.querySelector(".fl-slot-ghost")!.getBoundingClientRect();
    const inside = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.top >= card.top - 0.5 && box.bottom <= card.bottom + 0.5;
    };
    return {
      headline: inside(node.querySelector(".fl-slot-cta-label")!),
      actions: [...node.querySelectorAll("button")].map(button => [button.textContent!.trim(), inside(button)]),
    };
  });

  expect(painted.headline, "the headline is clipped out of the card").toBe(true);
  expect(painted.actions, "a way out is clipped out of the card")
    .toEqual([["Try again", true], ["Clear this slot", true]]);

  await slot.screenshot({ path: screenshotPath("slot-failed-short"), animations: "disabled" });
});
