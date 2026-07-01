import { test, expect } from "@playwright/test";

test("gate gen-code: a novel generated component evaluates, meshes with prewired + host siblings, binds data, and dispatches", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-code");
  const frame = page.frameLocator("#flowlet-stage");

  await expect(frame.getByText("prewired sibling")).toBeVisible();
  await expect(frame.locator('[data-generated-impl="Gauge"]')).toBeVisible();
  await expect(frame.getByRole("heading", { name: "Host sibling" })).toBeVisible();

  await expect(frame.locator("[data-gauge-value]")).toHaveText("42");

  await frame.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator("#action-log")).toHaveText("origin=g1 action=gauge_reset result=ok");
});

test("gate gen-code-error: a broken generated module is contained per-name; siblings render", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-code-error");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.locator('[data-error="generated:Broken"]')).toBeVisible();
  await expect(frame.locator('[data-generated-impl="Fine"]')).toBeVisible();
});
