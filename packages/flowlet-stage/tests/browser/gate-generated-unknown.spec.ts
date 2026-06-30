import { test, expect } from "@playwright/test";

test("gate generated-unknown: an unknown host component name renders a contained error while a sibling still renders", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=gen-unknown");
  const frame = page.frameLocator("#flowlet-stage");

  // The unknown host name resolves to a contained [data-error] node. It is an
  // empty marker div (zero-height), so assert it exists rather than is visible.
  await expect(frame.locator("[data-error]")).toBeAttached();
  await expect(frame.locator("[data-error]")).toHaveAttribute(
    "data-error",
    "unknown:NopeNotReal",
  );

  // ...and the present sibling Text still renders (per-node isolation).
  await expect(frame.getByText("sibling lives")).toBeVisible();
});
