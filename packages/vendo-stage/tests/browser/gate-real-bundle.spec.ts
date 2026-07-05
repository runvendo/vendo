import { test, expect } from "@playwright/test";

/**
 * Regression gates for the two failure modes the ENG-184 audit found in the
 * REAL @vendoai/components sandbox bundle (the sample bundles used by the
 * other gates masked both):
 *
 *  1. Shim exports: the externalized bundle statically imports named React
 *     APIs ({ PureComponent, useState, … } from "react", { createPortal }
 *     from "react-dom", { Fragment } from "react/jsx-runtime"). If the built
 *     shim drops them (the `export *` CJS-interop bug), the bundle fails at
 *     module link time and the whole stage renders blank.
 *
 *  2. Base CSS: the bundle must carry OpenUI's stylesheet, or every catalog
 *     component renders as bare unstyled HTML.
 */

test("gate real-bundle 1: the real components bundle imports against the shim and renders a catalog Card", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=real-bundle");
  const frame = page.frameLocator("#vendo-stage");
  await expect(frame.getByText("Real Bundle")).toBeVisible();
  await expect(frame.getByText("catalog card")).toBeVisible();
});

test("gate real-bundle 2: OpenUI base CSS ships with the bundle — the Card is styled, not bare HTML", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=real-bundle");
  const frame = page.frameLocator("#vendo-stage");
  await expect(frame.getByText("Real Bundle")).toBeVisible();

  // The OpenUI Card wrapper (class openui-card) must have a stylesheet-driven
  // border-radius; without the CSS it computes to the UA default 0px.
  const card = frame.locator('[class*="openui-card"]').first();
  await expect(card).toBeVisible();
  const borderRadius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(borderRadius).not.toBe("0px");
});

test("gate real-bundle 3: a catalog Actions component dispatches through the governed bridge", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=real-bundle-actions");
  const frame = page.frameLocator("#vendo-stage");
  const button = frame.getByRole("button", { name: "Freeze card" });
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled(); // catalog components receive the dispatch capability
  await button.click();
  await expect(page.locator("#action-log")).toContainText("action=freeze_card");
});

test("gate real-bundle 4: a denied dispatch REJECTS in-sandbox and the Actions component surfaces it", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=real-bundle-actions");
  const frame = page.frameLocator("#vendo-stage");
  const button = frame.getByRole("button", { name: "Deny me" });
  await expect(button).toBeVisible();
  await button.click();
  // The bridge error must reject the dispatch promise (not resolve undefined),
  // and the component must tell the user instead of silently idling.
  await expect(frame.getByText(/could not complete/i)).toBeVisible();
});
