import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const chromeScenarios = [
  "thread",
  "thread-citations",
  "overlay",
  "approval",
  "notice",
  "stage",
  "slot",
] as const;

// Audit the SETTLED state: the ported design has entrance animations (fade/rise)
// that briefly composite text at <1 opacity — a transient state axe would flag as
// low-contrast. Reduced motion (which the chrome CSS freezes to full opacity) is
// both the stable thing to audit and the exact state vestibular users get.
test.use({ reducedMotion: "reduce" });

for (const scenario of chromeScenarios) {
  test(`${scenario} has zero WCAG 2.1 A/AA axe violations`, async ({ page }) => {
    test.fixme(
      scenario === "stage",
      "the voice stage no longer renders its transcript inline (it moved behind the Transcript drawer), so the readiness gate 'Revenue is ready' never appears; needs a voice-lane decision on what the audited settled state is.",
    );
    await openScenario(page, scenario);
    if (scenario === "thread") await expect(page.getByLabel("Approval for Email send")).toBeVisible();
    if (scenario === "thread-citations") {
      // Audit all three Surface-2 trust states, popover expanded.
      await expect(page.locator("[data-vendo-knowledge-unavailable]")).toBeVisible();
      await page.locator(".fl-cite-btn").first().click();
      await expect(page.locator(".fl-cite-pop--open")).toBeVisible();
    }
    if (scenario === "overlay") await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
    if (scenario === "notice") await expect(page.getByRole("region", { name: "Vendo is running without a policy" })).toBeVisible();
    if (scenario === "stage") await expect(page.getByText("Revenue is ready")).toBeVisible();
    if (scenario === "slot") await expect(page.getByText("Invoices app surface")).toBeVisible();

    // Audit the fully-settled state: entrance animations (fade/rise) briefly hold
    // elements at <1 opacity, which composites text/fills lighter. Wait for every
    // FINITE animation to finish — but bound it, since the voice presence runs a
    // continuous (infinite) breathe/ball whose `finished` never resolves.
    await page.evaluate(() => {
      const finite = document.getAnimations().filter(a => {
        const iterations = (a.effect?.getTiming().iterations ?? 1);
        return Number.isFinite(iterations);
      });
      return Promise.race([
        Promise.all(finite.map(a => a.finished.catch(() => undefined))),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]);
    });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
