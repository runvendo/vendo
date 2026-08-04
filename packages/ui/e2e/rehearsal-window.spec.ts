import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const EVIDENCE = process.env.REHEARSAL_EVIDENCE_DIR ?? "./e2e/test-results";
const shot = (name: string) => `${EVIDENCE}/${name}.png`;

/**
 * PR #2 — Automation Rehearsal window selection (07-automations §1 / 08-ui
 * amendment). Drives the REAL AutomationsPanel against the harness wire:
 *  - the trigger button reads plain "Rehearse" (busy label "Rehearsing…"),
 *    never naming a window;
 *  - the first click sends no window arg and the report comes back over the
 *    30-day default — the results header reads "Rehearsal — last 30 days";
 *  - a 7d/30d segmented control lives INSIDE the results (only after the first
 *    rehearsal); flipping to 7d re-fetches and replaces the report in place, so
 *    the header becomes "last 7 days" and 7d is the pressed segment.
 */
test("rehearse trigger is unnamed; the in-results 7d/30d toggle re-runs the window", async ({ page }) => {
  await openScenario(page, "automations");

  // (1) The trigger button is plain "Rehearse" — the window is never named on it.
  // Scope it to the intended automation's row (asserting that row's identity) so
  // the locator is unambiguous even when other rehearsable rows are present —
  // a bare "Rehearse" locator would match one button per eligible row and trip
  // Playwright's strict-mode check.
  const row = page.locator(".fl-automation").filter({ hasText: "Invoice watcher" });
  await expect(row).toHaveCount(1);
  const trigger = row.getByRole("button", { name: "Rehearse", exact: true });
  await expect(trigger).toBeVisible();
  // No results panel and therefore no window toggle exist before the first run.
  await expect(page.getByRole("group", { name: "Rehearsal window" })).toHaveCount(0);

  // (2) First click → defaults to the 30-day window server-side.
  await trigger.click();
  const results = page.getByLabel(/^Rehearsal for /);
  await expect(results.getByText("Rehearsal — last 30 days")).toBeVisible();
  const toggle = page.getByRole("group", { name: "Rehearsal window" });
  await expect(toggle.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");
  await expect(toggle.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: shot("rehearsal-window-30d"), fullPage: true, animations: "disabled" });

  const firingsAt30 = await results.locator("article").count();

  // (4) Flip to 7d inside the results — re-fetches and replaces the report in place.
  await toggle.getByRole("button", { name: "7d" }).click();
  await expect(results.getByText("Rehearsal — last 7 days")).toBeVisible();
  await expect(toggle.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
  await expect(toggle.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "false");
  // The narrower window replays strictly fewer daily firings than the 30-day one.
  const firingsAt7 = await results.locator("article").count();
  expect(firingsAt7).toBeLessThan(firingsAt30);
  await page.screenshot({ path: shot("rehearsal-window-7d"), fullPage: true, animations: "disabled" });
});
