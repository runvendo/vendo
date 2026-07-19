import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

const shots = [
  { scenario: "thread", file: "thread-dark", ready: 'article[aria-label="Approval for Email send"]' },
  { scenario: "overlay", file: "overlay", ready: '[role="dialog"][aria-label="Vendo assistant"]' },
  { scenario: "page", file: "page", ready: '[role="tab"][aria-selected="true"]' },
  { scenario: "palette", file: "palette", ready: '[role="dialog"][aria-label="Vendo assistant"]' },
  { scenario: "approval", file: "approval", ready: 'article[aria-label="Approval for Delete invoice"]' },
  { scenario: "thread-humanized", file: "thread-humanized", ready: 'article[aria-label="Approval for Transfer funds"]' },
  { scenario: "activity", file: "activity", ready: 'table[aria-describedby], table' },
  { scenario: "automations", file: "automations", ready: '[role="switch"]' },
  { scenario: "notice", file: "notice", ready: '[role="region"][aria-label="Vendo is running without a policy"]' },
  { scenario: "stage", file: "stage", ready: '[aria-label="Voice transcript"]' },
  { scenario: "tree", file: "tree", ready: '[data-dangling-node="not-yet-streamed"]' },
  { scenario: "tree-jail", file: "tree-jail", ready: 'iframe[title="Generated component: SecurityProbe"]' },
  { scenario: "tree-themed", file: "tree-themed", ready: '[data-vendo-node-id="host"]' },
  { scenario: "appframe", file: "appframe", ready: 'section[aria-label="HTTP app frame same-origin"] iframe' },
] as const;

for (const shot of shots) {
  test(`captures ${shot.file}.png`, async ({ page }) => {
    await openScenario(page, shot.scenario);
    await expect(page.locator(shot.ready).first()).toBeVisible();
    if (shot.scenario === "page") await expect(page.getByRole("tab", { name: "Apps" })).toHaveAttribute("aria-selected", "true");
    if (shot.scenario === "stage") await expect(page.getByText("Revenue is ready")).toBeVisible();
    if (shot.scenario === "appframe") await expect(page.frameLocator('section[aria-label="HTTP app frame same-origin"] iframe').getByText("Local HTTP app")).toBeVisible();
    await page.screenshot({ path: screenshotPath(shot.file), fullPage: true, animations: "disabled" });
  });
}
