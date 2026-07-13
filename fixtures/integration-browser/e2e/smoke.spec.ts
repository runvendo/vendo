/** A minimal smoke: the shipped Vendo React surface mounts against the composed
 *  wire and renders its chrome. Breadth belongs to the node suite — this only
 *  guards that the page boots and the wire is reachable same-origin. */
import { expect, test } from "@playwright/test";

test("the Vendo React surface mounts and reaches the composed wire", async ({ page }) => {
  await page.goto("/");
  // The thread chrome rendered its composer (empty-thread landing).
  await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
  // The useApps probe mounted and completed its GET /apps against the wire.
  await expect(page.getByTestId("apps-probe")).toBeVisible();
  await expect(page.getByTestId("apps-create")).toBeVisible();
});
