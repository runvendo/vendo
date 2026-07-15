import { expect, test } from "@playwright/test";
import { jailFrame, openScenario, screenshotPath } from "./helpers.js";

/**
 * 06-apps §9 — the in-client venue in a real browser: the SAME generated
 * source mounts natively in the host page under a granted hash-pinned
 * approval, and drops back to the sandboxed iframe jail (loudly) when the
 * approval no longer matches the version.
 */
test("an approved component mounts in the host page with host-page authority", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await openScenario(page, "tree-inclient");

  const approved = page.locator('section[aria-label="Approved in-client venue"]');
  // Host-page DOM: the promoted card is NOT inside any iframe.
  await expect(approved.locator('[data-vendo-inclient-mount="PromotedCard"]')).toBeVisible();
  await expect(approved.locator("iframe")).toHaveCount(0);
  await expect(approved.getByRole("heading", { name: "Promoted card for Ada" })).toBeVisible();

  // Host-page authority: the same fetch the jail's CSP forbids succeeds here.
  await approved.getByRole("button", { name: "Probe host fetch" }).click();
  await expect(approved.locator("#inclient-fetch-status")).toHaveText("fetch: SUCCESS (host authority)");

  // $action props are live functions dispatching through the tree chokepoint.
  await approved.getByRole("button", { name: "Dispatch promoted action" }).click();
  await expect(approved.locator("#inclient-action-status")).toHaveText("action: delivered");
  await expect(page.getByTestId("inclient-action-recorder")).toHaveText(JSON.stringify({
    nodeId: "promoted",
    action: "fn:promoted-submit",
    payload: { invoiceId: "inv_42" },
  }));

  expect(pageErrors, "an approved mount must not throw uncaught page errors").toEqual([]);
});

test("a stale approval drops the same component back to the CSP jail, loudly", async ({ page }) => {
  await openScenario(page, "tree-inclient");

  const stale = page.locator('section[aria-label="Stale in-client approval"]');
  // Loud drop-back: the invalidation notice renders in-surface, above the tree.
  await expect(stale.getByRole("note", { name: "In-client approval invalidated" }))
    .toContainText("re-approved");
  // The component is back in the sandboxed iframe, not the host page.
  await expect(stale.locator("[data-vendo-inclient-mount]")).toHaveCount(0);
  await expect(stale.locator('iframe[title="Generated component: PromotedCard"]')).toBeVisible();

  const jail = jailFrame(page, "PromotedCard");
  await expect(jail.getByRole("heading", { name: "Promoted card for Ada" })).toBeVisible();
  // The jail's CSP still forbids the exact fetch that succeeded in-client.
  await jail.getByRole("button", { name: "Probe host fetch" }).click();
  await expect(jail.locator("#inclient-fetch-status")).toHaveText("fetch: FAILURE (CSP)");

  // Sibling host content is unaffected in both sections.
  await expect(page.getByText("Host sibling survived")).toHaveCount(2);

  await page.screenshot({ path: screenshotPath("tree-inclient"), fullPage: true, animations: "disabled" });
});
