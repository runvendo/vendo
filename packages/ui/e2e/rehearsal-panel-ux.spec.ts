import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const EVIDENCE = process.env.REHEARSAL_EVIDENCE_DIR ?? "./e2e/test-results";
const shot = (name: string) => `${EVIDENCE}/${name}.png`;

/**
 * PR #1 (fm/build-vendo-rehearsal) — the three shipped-Rehearsal UX fixes in
 * AutomationsPanel, exercised against the REAL panel over the harness wire:
 *
 *  1. The rehearsal firings box renders at its full natural height with no
 *     nested inner scroll — the page-level `.fl-auto-scroll` is the single
 *     scrollbar. A `minHeight` high-water-mark floor (locked by the default 30d
 *     window) keeps the box from visibly shrinking on the 7d/30d flip, so the
 *     panel never resizes and reflows the cards below it.
 *  2. The Automations <section> owns a scroll region (`.fl-auto-scroll`), so
 *     under an overflow:hidden host a tall panel scrolls instead of clipping
 *     content below the fold. Removing the class removes the scroll region.
 *  3. The firing-row disclosure (▸/▾) is a row-level flex item, not a child of
 *     the truncating `.fl-act-sub`, so it stays hit-testable at a narrow host
 *     width instead of being clipped out of its box.
 */

test("1) full-height rehearsal box has no inner scroll and never shrinks across the 7d/30d flip", async ({ page }) => {
  await openScenario(page, "automations");

  await page.getByRole("button", { name: "Rehearse", exact: true }).click();
  const results = page.getByLabel(/^Rehearsal for /);
  await expect(results.getByText("Rehearsal — last 30 days")).toBeVisible();

  const body = results.locator(".fl-act-body");
  const panelHeightAt = async () => Math.round((await results.boundingBox())!.height);
  const bodyHeightAt = async () => Math.round((await body.boundingBox())!.height);
  const innerScrollAt = async () =>
    body.evaluate(el => ({ scrollH: el.scrollHeight, clientH: el.clientHeight }));

  // 30-day window: many rows rendered at full natural height. The box has NO
  // inner scroll (content is not clipped) and is taller than the old 320 cap.
  const firingsAt30 = await results.locator("article").count();
  const panel30 = await panelHeightAt();
  const box30 = await bodyHeightAt();
  const scroll30 = await innerScrollAt();
  expect(scroll30.scrollH).toBeLessThanOrEqual(scroll30.clientH + 1); // no nested inner scroll
  expect(box30).toBeGreaterThan(320); // full list, past the old cap
  await page.screenshot({ path: shot("ux1-rehearsal-30d"), fullPage: true, animations: "disabled" });

  // Flip to 7d: strictly fewer rows, yet the minHeight high-water-mark floor
  // (locked by the 30d window) keeps the box from visibly shrinking — so the
  // whole panel does not resize and reflow the cards below it.
  await page.getByRole("group", { name: "Rehearsal window" }).getByRole("button", { name: "7d" }).click();
  await expect(results.getByText("Rehearsal — last 7 days")).toBeVisible();
  const firingsAt7 = await results.locator("article").count();
  const panel7 = await panelHeightAt();
  const box7 = await bodyHeightAt();
  const scroll7 = await innerScrollAt();

  expect(firingsAt7).toBeLessThan(firingsAt30); // fewer rows at 7d…
  expect(box7).toBeGreaterThanOrEqual(box30); // …but the minHeight floor holds, box never shrinks…
  expect(panel7).toBe(panel30); // …so the panel does not resize/reflow.
  expect(scroll7.scrollH).toBeLessThanOrEqual(scroll7.clientH + 1); // still no inner scroll
  await page.screenshot({ path: shot("ux1-rehearsal-7d"), fullPage: true, animations: "disabled" });
});

test("2) .fl-auto-scroll gives the section a scroll region under a bounded host", async ({ page }) => {
  await openScenario(page, "automations");

  // Reproduce a real host: an overflow:hidden pane of bounded height wrapping
  // the panel (the harness canvas is otherwise unbounded, so nothing scrolls).
  await page.addStyleTag({ content: `
    main[data-scenario="automations"] .harness-surface {
      height: 380px; overflow: hidden; display: flex; flex-direction: column; min-height: 0;
    }
    main[data-scenario="automations"] .vendo-root {
      flex: 1; min-height: 0; display: flex; flex-direction: column;
    }
  ` });

  // Make the panel tall enough to overflow the 380px pane.
  await page.getByRole("button", { name: "Rehearse", exact: true }).click();
  await expect(page.getByText("Rehearsal — last 30 days")).toBeVisible();

  const section = page.locator("section.fl-auto-scroll");
  const metrics = await section.evaluate(el => ({ scrollH: el.scrollHeight, clientH: el.clientHeight }));
  // The content genuinely overflows the bounded pane.
  expect(metrics.scrollH).toBeGreaterThan(metrics.clientH + 20);

  // …and the section is the element that actually scrolls it.
  const scrolled = await section.evaluate(el => {
    el.scrollTop = 10_000;
    return el.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await page.screenshot({ path: shot("ux2-section-scrolled"), fullPage: true, animations: "disabled" });

  // Control: strip the class → the scroll region disappears (overflow becomes
  // visible), so the same tall content can no longer be scrolled — content below
  // the fold is unreachable. This is exactly the pre-fix behaviour.
  const scrolledWithoutClass = await section.evaluate(el => {
    el.classList.remove("fl-auto-scroll");
    el.scrollTop = 0;
    el.scrollTop = 10_000;
    return el.scrollTop;
  });
  expect(scrolledWithoutClass).toBe(0);
});

test("3) firing-row disclosure is hit-testable and toggles at a narrow host width", async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 900 });
  await openScenario(page, "automations");

  await page.getByRole("button", { name: "Rehearse", exact: true }).click();
  await expect(page.getByText("Rehearsal — last 30 days")).toBeVisible();

  const toggle = page.getByRole("button", { name: /details for the .* firing$/ }).first();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // The regression was invisible to selector clicks: the button rendered but sat
  // clipped out of the overflow:hidden .fl-act-sub box, so the point at its
  // centre belonged to a different element. elementFromPoint must now return the
  // button itself (or a descendant of it).
  const hit = await toggle.evaluate(el => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      isButtonOrInside: !!at && (at === el || el.contains(at) || at.closest("button") === el),
      hitTag: at?.tagName ?? null,
    };
  });
  expect(hit.isButtonOrInside).toBe(true);

  await page.screenshot({ path: shot("ux3-narrow-collapsed"), fullPage: true, animations: "disabled" });

  // A real hit-tested click (Playwright verifies actionability incl. hit-test)
  // now toggles the row open — and closed again.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: shot("ux3-narrow-expanded"), fullPage: true, animations: "disabled" });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
