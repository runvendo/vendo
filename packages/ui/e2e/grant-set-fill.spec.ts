import { expect, test, type Locator } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Standing-access grant-set card fill (fm/build-vendo-rehearsal).
 *
 * Drives the REAL AutomationsPanel against the harness wire: enabling the
 * automation mints its standing asks, so the grant-set card (.fl-grantset — a
 * .fl-approval rendered DIRECTLY inside .fl-automation) appears beneath the
 * Dry run / Rehearse / Run history button row. The fix (.fl-automation >
 * .fl-approval { align-self: stretch; width: calc(100% - 32px); margin: 0 16px })
 * must make the card span the SAME width as its siblings inside the automation
 * card — its left/right border edges flush with the button row's 16px content
 * insets — at 1200 / 1440 / 1920px, instead of floating at content width with
 * dead space on the right. Symmetric insets + growth with the viewport are the
 * geometric signature of a card that fills rather than hugging its content.
 */

const EVIDENCE = process.env.GRANT_EVIDENCE_DIR ?? "./e2e/test-results";

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("locator has no bounding box");
  return { left: b.x, right: b.x + b.width, width: b.width };
}

test("grant-set card fills to its siblings' width at 1200/1440/1920", async ({ page }) => {
  await openScenario(page, "automations");

  // Enable the automation → the engine mints the standing asks → grant card.
  await page.getByRole("switch", { name: /^Enable / }).first().click();

  const card = page.locator("article.fl-automation");
  const grant = card.locator("article[data-vendo-grant-set-card]");
  await expect(grant).toBeVisible();
  await expect(grant.getByText("Standing access")).toBeVisible();

  // The Dry run / Rehearse / Run history row — a sibling that already sits at
  // the automation card's 16px content insets (its .fl-auto-flow container).
  const dryRun = page.getByRole("button", { name: "Dry run", exact: true });
  const buttonRow = card.locator(".fl-auto-flow").filter({ has: dryRun });

  const widths = [1200, 1440, 1920] as const;
  const grantWidths: number[] = [];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(grant).toBeVisible();

    const g = await box(grant);
    const row = await box(buttonRow);
    const btn = await box(dryRun);
    const c = await box(card);
    const leftInset = g.left - c.left;
    const rightInset = c.right - g.right;
    grantWidths.push(g.width);

    const report = `width=${width} grant[l=${g.left.toFixed(0)} r=${g.right.toFixed(0)} w=${g.width.toFixed(0)}] `
      + `buttonRow[l=${row.left.toFixed(0)} r=${row.right.toFixed(0)}] dryRunBtn[l=${btn.left.toFixed(0)}] `
      + `card[l=${c.left.toFixed(0)} r=${c.right.toFixed(0)}] insets[left=${leftInset.toFixed(1)} right=${rightInset.toFixed(1)}]`;
    // eslint-disable-next-line no-console -- surfaced as CLI evidence
    console.log(report);

    // Left edge flush with the button row's left inset (the Dry run button).
    expect(Math.abs(g.left - btn.left), report).toBeLessThanOrEqual(1.5);
    // The card's border edges land on the button row's 16px content insets.
    expect(Math.abs(g.left - (row.left + 16)), report).toBeLessThanOrEqual(1.5);
    expect(Math.abs(g.right - (row.right - 16)), report).toBeLessThanOrEqual(1.5);
    // Symmetric insets inside the automation card — no dead space on the right.
    expect(Math.abs(leftInset - rightInset), report).toBeLessThanOrEqual(1.5);
    // The right inset is the small 16px content gutter (~17px with the 1px
    // border), NOT the wide gap the pre-fix content-width card left behind.
    expect(rightInset, report).toBeLessThanOrEqual(20);
    // It genuinely FILLS the automation card: the grant card takes the full
    // inner width minus the two 16px gutters (~34px), not its content width.
    expect(g.width, report).toBeGreaterThanOrEqual(c.width - 36);

    await card.screenshot({
      path: `${EVIDENCE}/grant-set-fill-${width}.png`,
      animations: "disabled",
    });
  }

  // The card tracks its container's width across viewports (it is not pinned to
  // a fixed content width): every measured width fills its automation card.
  expect(grantWidths.every(w => w >= 200)).toBe(true);
});
