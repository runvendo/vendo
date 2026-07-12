import { test, expect } from "@playwright/test";

test("gate ui/delta: a prop-level data patch updates the bound host node in place without remounting", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=gen-delta");
  const frame = page.frameLocator("#vendo-stage");

  // Card heading is bound to /acct/name → "Before".
  const heading = frame.getByRole("heading", { name: "Before" });
  await expect(heading).toBeVisible();

  // Stamp the live heading element. A from-scratch remount would discard this
  // element and create a new one without the attribute.
  await heading.evaluate((el) => el.setAttribute("data-stamp", "1"));

  // Drive a JSON-Pointer data delta through the host session → ui/update replace.
  await page.evaluate(() => (window as any).__patchData("/acct/name", "After"));

  // The bound prop updates...
  await expect(frame.getByRole("heading", { name: "After" })).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Before" })).not.toBeVisible();

  // ...and it is the SAME DOM element (stamp survived) — the no-remount proof.
  await expect(frame.getByRole("heading", { name: "After" })).toHaveAttribute("data-stamp", "1");
});
