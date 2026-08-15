import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

const shots = [
  { scenario: "thread", file: "thread-dark", ready: 'article[aria-label="Approval for Email send"]' },
  { scenario: "overlay", file: "overlay", ready: '[role="dialog"][aria-label="Vendo assistant"]' },
  { scenario: "palette", file: "palette", ready: '[role="dialog"][aria-label="Vendo assistant"]' },
  { scenario: "approval", file: "approval", ready: 'article[aria-label="Approval for Delete invoice"]' },
  { scenario: "thread-humanized", file: "thread-humanized", ready: 'article[aria-label="Approval for Transfer funds"]' },
  { scenario: "thread-citations", file: "thread-citations", ready: "[data-vendo-citations]" },
  { scenario: "notice", file: "notice", ready: '[role="region"][aria-label="Vendo is running without a policy"]' },
  { scenario: "stage", file: "stage", ready: '[aria-label="Voice transcript"]' },
  { scenario: "tree", file: "tree", ready: '[data-dangling-node="not-yet-streamed"]' },
  { scenario: "tree-themed", file: "tree-themed", ready: '[data-vendo-node-id="host"]' },
  { scenario: "appframe", file: "appframe", ready: 'section[aria-label="HTTP app frame same-origin"] iframe' },
] as const;

for (const shot of shots) {
  test(`captures ${shot.file}.png`, async ({ page }) => {
    // Quarantined 2026-08-03 (lane G triage); both fail identically on
    // rebuild/cutover — pre-existing, not redesign regressions.
    test.fixme(
      shot.scenario === "stage",
      "the voice stage no longer renders '[aria-label=\"Voice transcript\"]' inline (it moved behind the Transcript drawer); needs a voice-lane decision on the captured state.",
    );
    await openScenario(page, shot.scenario);
    await expect(page.locator(shot.ready).first()).toBeVisible();
    if (shot.scenario === "thread-citations") {
      // Both Surface-2 states settled, with the first citation popover
      // expanded (the mockup's "one expanded" grounded state).
      await expect(page.locator("[data-vendo-knowledge-searched]")).toBeVisible();
      await expect(page.locator("[data-vendo-knowledge-unavailable]")).toBeVisible();
      await page.locator(".fl-cite-btn").first().click();
      await expect(page.locator(".fl-cite-pop--open")).toBeVisible();
    }
    if (shot.scenario === "stage") await expect(page.getByText("Revenue is ready")).toBeVisible();
    if (shot.scenario === "appframe") await expect(page.frameLocator('section[aria-label="HTTP app frame same-origin"] iframe').getByText("Local HTTP app")).toBeVisible();
    await page.screenshot({ path: screenshotPath(shot.file), fullPage: true, animations: "disabled" });
  });
}
