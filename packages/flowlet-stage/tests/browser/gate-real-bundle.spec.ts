import { test, expect } from "@playwright/test";

/**
 * Regression gates for the two failure modes the ENG-184 audit found in the
 * REAL @flowlet/components sandbox bundle (the sample bundles used by the
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
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByText("Real Bundle")).toBeVisible();
  await expect(frame.getByText("catalog card")).toBeVisible();
});

test("gate real-bundle 2: OpenUI base CSS ships with the bundle — the Card is styled, not bare HTML", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=real-bundle");
  const frame = page.frameLocator("#flowlet-stage");
  await expect(frame.getByText("Real Bundle")).toBeVisible();

  // The OpenUI Card wrapper (class openui-card) must have a stylesheet-driven
  // border-radius; without the CSS it computes to the UA default 0px.
  const card = frame.locator('[class*="openui-card"]').first();
  await expect(card).toBeVisible();
  const borderRadius = await card.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(borderRadius).not.toBe("0px");
});
