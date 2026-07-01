import { test, expect } from "@playwright/test";

test("gate generated: a resolved GenUI tree of prewired primitives + host component renders in one stage", async ({
  page,
}) => {
  await page.goto("/fixtures/host.html?case=gen-basic");
  const frame = page.frameLocator("#flowlet-stage");

  // Prewired Text primitive renders its literal prop.
  await expect(frame.getByText("hello")).toBeVisible();
  // Host Card, resolved by name from the bundle, renders its heading.
  await expect(frame.getByRole("heading", { name: "Card title" })).toBeVisible();
  // Prewired Stack layout primitive is present in the tree.
  await expect(frame.locator('[data-primitive="Stack"]')).toBeVisible();
});
