import { expect, test } from "@playwright/test";
import { jailFrame, openScenario, screenshotPath } from "./helpers.js";

/**
 * 06-apps §8 — pin drift in a real browser: when the host updated the
 * component a pin was remixed from, the surface says so loudly above the tree
 * while the remixed fork keeps rendering, sandboxed and untouched. Drift is
 * informational — nothing rebase-shaped happens without the user asking.
 */
test("a drifted pin renders a loud in-surface notice above the still-working remix", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "tree-drift");

  const section = page.locator('section[aria-label="Drifted remixed pin"]');
  // Loud: the drift notice renders in-surface, above the tree.
  const notice = section.getByRole("note", { name: "Remixed component out of date" });
  await expect(notice).toContainText('"net-worth-card"');
  await expect(notice).toContainText("rebase");

  // Untouched: the remixed fork still renders in its sandboxed jail.
  await expect(section.locator('iframe[title="Generated component: RemixedNetWorthCard"]')).toBeVisible();
  const jail = jailFrame(page, "RemixedNetWorthCard");
  await expect(jail.getByRole("heading", { name: "Net worth — remixed" })).toBeVisible();

  // Sibling host content is unaffected.
  await expect(page.getByText("Host sibling survived")).toBeVisible();

  expect(pageErrors, "a drift notice must not throw uncaught page errors").toEqual([]);
  await page.screenshot({ path: screenshotPath("tree-drift"), fullPage: true, animations: "disabled" });
});
