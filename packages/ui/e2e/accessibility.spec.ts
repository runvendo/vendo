import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

const chromeScenarios = [
  "thread",
  "overlay",
  "page",
  "palette",
  "approval",
  "activity",
  "automations",
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
    await openScenario(page, scenario);
    if (scenario === "thread") await expect(page.getByLabel("Approval for host_email_send")).toBeVisible();
    if (scenario === "overlay") await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
    if (scenario === "page") await expect(page.getByRole("tab", { name: "Apps" })).toHaveAttribute("aria-selected", "true");
    if (scenario === "palette") await expect(page.getByRole("dialog", { name: "Vendo command palette" })).toBeVisible();
    if (scenario === "activity") await expect(page.getByText("host_invoices_list").first()).toBeVisible();
    if (scenario === "automations") await expect(page.getByRole("switch")).toBeVisible();
    if (scenario === "notice") await expect(page.getByRole("region", { name: "Vendo is running without a policy" })).toBeVisible();
    if (scenario === "stage") await expect(page.getByText("Revenue is ready")).toBeVisible();
    if (scenario === "slot") await expect(page.getByText("Invoices app surface")).toBeVisible();

    // Audit the fully-settled state: entrance animations (fade/rise) briefly hold
    // elements at <1 opacity, which composites text/fills lighter. Wait for every
    // running animation to finish so axe sees the resting colors, not a transient frame.
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))));

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
