import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/** block-actions design §C — minimal org management chrome (ENG-263). */

test("orgs panel lists orgs with members, invites, and changes roles", async ({ page }) => {
  await openScenario(page, "orgs");
  await expect(page.locator("#vendo-orgs-heading")).toBeVisible();
  const acme = page.getByRole("article", { name: "Org Acme Corp" });
  await expect(acme).toBeVisible();
  await expect(acme.getByText("you are owner")).toBeVisible();
  await expect(acme.getByText("user_bob", { exact: true })).toBeVisible();

  // Invite a member.
  await acme.getByLabel("Invite member to Acme Corp").fill("user_cleo");
  await acme.getByRole("button", { name: "Invite" }).click();
  await expect(acme.getByText("user_cleo", { exact: true })).toBeVisible();

  // Promote them to admin through the role select.
  await acme.getByLabel("Role for user_cleo").selectOption("admin");
  await expect(acme.getByLabel("Role for user_cleo")).toHaveValue("admin");

  // Remove bob.
  await acme.getByRole("button", { name: "Remove user_bob" }).click();
  await expect(acme.getByText("user_bob", { exact: true })).toBeHidden();

  await page.screenshot({ path: screenshotPath("orgs"), fullPage: true, animations: "disabled" });
});

test("orgs panel creates a new org and shows the creator as owner", async ({ page }) => {
  await openScenario(page, "orgs");
  await page.getByLabel("New organization name").fill("Beta LLC");
  await page.getByRole("button", { name: "Create org" }).click();
  const beta = page.getByRole("article", { name: "Org Beta LLC" });
  await expect(beta).toBeVisible();
  await expect(beta.getByText("you are owner")).toBeVisible();
});

test("key-gated posture renders the honest upgrade state, not an error wall", async ({ page }) => {
  await openScenario(page, "orgs-gated");
  await expect(page.getByTestId("orgs-gated")).toContainText("VENDO_API_KEY");
  // No create form and no orgs render while gated.
  await expect(page.getByRole("button", { name: "Create org" })).toBeHidden();
  await page.screenshot({ path: screenshotPath("orgs-gated"), fullPage: true, animations: "disabled" });
});
