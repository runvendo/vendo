import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const EVIDENCE = process.env.REHEARSAL_EVIDENCE_DIR ?? "./e2e/test-results";
const shot = (name: string) => `${EVIDENCE}/${name}.png`;

/**
 * Rehearsal timeline — every firing row starts collapsed (including the
 * newest). Drives the REAL AutomationsPanel against the harness wire:
 *  - after Rehearse, no firing row's detail toggle is expanded — every row
 *    (newest first included) reports aria-expanded="false" and shows no
 *    per-step detail;
 *  - clicking the NEWEST row's toggle expands it (detail becomes visible);
 *  - clicking it again collapses it back.
 */
test("every rehearsed firing row is collapsed by default; click toggles the newest", async ({ page }) => {
  await openScenario(page, "automations");

  // Scope the trigger to its automation row: a bare "Rehearse" locator matches
  // one button per eligible row and would trip Playwright strict mode.
  const row = page.locator(".fl-automation").filter({ hasText: "Invoice watcher" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Rehearse", exact: true }).click();
  const results = page.getByLabel(/^Rehearsal for /);
  await expect(results.getByText("Rehearsal — last 30 days")).toBeVisible();

  // Each firing row carries a Show/Hide-details toggle. Every one must start
  // collapsed — no exception for the newest.
  const toggles = results.getByRole("button", { name: /details for the .* firing$/ });
  const toggleCount = await toggles.count();
  expect(toggleCount).toBeGreaterThan(1);
  for (let index = 0; index < toggleCount; index += 1) {
    await expect(toggles.nth(index)).toHaveAttribute("aria-expanded", "false");
    await expect(toggles.nth(index)).toHaveAccessibleName(/^Show details/);
  }
  // No expanded per-step detail (only rendered inside an open row) is present.
  await expect(results.getByText("Not executed — this is what it would have sent")).toHaveCount(0);
  await page.screenshot({ path: shot("rehearsal-all-collapsed"), fullPage: true, animations: "disabled" });

  // The newest firing is the first article. Its toggle opens on click.
  const newest = toggles.first();
  await newest.click();
  await expect(newest).toHaveAttribute("aria-expanded", "true");
  await expect(newest).toHaveAccessibleName(/^Hide details/);
  await expect(results.getByText("Not executed — this is what it would have sent").first()).toBeVisible();
  await page.screenshot({ path: shot("rehearsal-newest-expanded"), fullPage: true, animations: "disabled" });

  // Clicking again collapses it back.
  await newest.click();
  await expect(newest).toHaveAttribute("aria-expanded", "false");
  await expect(results.getByText("Not executed — this is what it would have sent")).toHaveCount(0);
});
