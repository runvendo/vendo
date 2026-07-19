import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-223 — verification captures (committed to docs/verification/eng-223/).
 * Not a behavioral gate (that is slot-cta-pin.test.tsx + slot-fallback.spec paths);
 * this spec produces the PR screenshots: the wired empty-state CTA (light + dark),
 * the CTA activated (opens the command palette), and a pinned component in the slot.
 */

const shotPath = (name: string) =>
  new URL(`../../../docs/verification/eng-223/${name}.png`, import.meta.url).pathname;

test("empty-state CTA — light", async ({ page }) => {
  await openScenario(page, "slot-empty");
  await expect(page.getByRole("button", { name: /design a view/i })).toBeVisible();
  await page.screenshot({ path: shotPath("01-empty-cta-light"), fullPage: false, animations: "disabled" });
});

test("empty-state CTA — dark", async ({ page }) => {
  await openScenario(page, "slot-empty-dark");
  await expect(page.getByRole("button", { name: /design a view/i })).toBeVisible();
  await page.screenshot({ path: shotPath("02-empty-cta-dark"), fullPage: false, animations: "disabled" });
});

test("CTA activated — opens the conversation surface", async ({ page }) => {
  // One-surface model (ui-lane-entry pick P-C): the slot CTA opens the
  // conversation overlay with the composer focused.
  await openScenario(page, "slot-empty");
  await page.getByRole("button", { name: /design a view/i }).click();
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
  await page.screenshot({ path: shotPath("03-cta-activated-palette"), fullPage: false, animations: "disabled" });
});

test("pinned component placed in the slot", async ({ page }) => {
  await openScenario(page, "slot-pinned");
  await expect(page.getByText("Outstanding this week")).toBeVisible();
  await page.screenshot({ path: shotPath("04-pinned-component"), fullPage: false, animations: "disabled" });
});
