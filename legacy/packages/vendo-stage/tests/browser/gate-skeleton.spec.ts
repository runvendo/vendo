import { test, expect } from "@playwright/test";

test("gate skeleton: a forward-referenced child resolves to a Skeleton beside a present sibling, then swaps to real content", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=gen-skeleton");
  const frame = page.frameLocator("#vendo-stage");

  // The present sibling Text renders normally.
  await expect(frame.getByText("present text")).toBeVisible();
  // The missing (forward-referenced) child renders as a streaming Skeleton.
  await expect(frame.locator('[data-skeleton="true"]')).toBeVisible();

  // Supplying the missing node via a structural replace swaps the skeleton for
  // real content in the same stage.
  await page.evaluate(() => (window as any).__supplyMissing());
  await expect(frame.getByText("now here")).toBeVisible();
  await expect(frame.locator('[data-skeleton="true"]')).toHaveCount(0);
});
