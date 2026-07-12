import { test, expect } from "@playwright/test";

test("gate 4: a button action round-trips through the chokepoint with provenance", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=action");
  const frame = page.frameLocator("#vendo-stage");
  await frame.getByTestId("card-btn").click();
  await expect(page.locator("#action-log")).toHaveText(
    "origin=c1 action=confirm result=ok",
  );
});
