import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

// The provider is optional. An embed dropped into a chat with no
// `<VendoProvider>` anywhere above it boots from the universal defaults — the
// wire at /api/vendo, auth riding the session cookie the browser already
// sends, and Vendo's own tokens — and does the whole job: render, poll, mount.
test("the embeds render and poll the default wire with no provider on the page", async ({ page }) => {
  const wireCalls: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/vendo")) wireCalls.push(path);
  });

  await openScenario(page, "byo-embed-bare");

  // The app embed polled the default mount and the app is live under its bar.
  await expect(page.locator('[data-vendo-embed="app"]')).toBeVisible();
  await expect(page.getByText("Invoices app surface")).toBeVisible();
  // The approval embed reached the same wire and offers the real decision.
  const approval = page.locator('[data-vendo-embed="approval"]');
  await expect(approval.getByRole("button", { name: "Approve" })).toBeVisible();
  // Chrome tokens, from nobody's provider: each embed still opens its own
  // themed boundary, on the defaults.
  await expect(page.locator(".vendo-root")).toHaveCount(2);
  const accent = await page.locator(".vendo-root").first()
    .evaluate(node => getComputedStyle(node).getPropertyValue("--vendo-color-accent").trim());
  expect(accent).not.toBe("");

  expect(wireCalls.some(path => path.startsWith("/api/vendo/apps/app_1/open"))).toBe(true);
  expect(wireCalls).toContain("/api/vendo/approvals/apr_1");

  await page.screenshot({ path: screenshotPath("byo-embed-bare"), fullPage: true, animations: "disabled" });
});
