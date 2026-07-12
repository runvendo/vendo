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

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
