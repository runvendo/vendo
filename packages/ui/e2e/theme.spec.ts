import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * 08-ui §4 — chrome adopts the host brand through VendoTheme CSS variables only;
 * no hardcoded brand color. Proof is on COMPUTED styles: a host theme override
 * must actually repaint the chrome, and two different overrides must diverge (a
 * hardcoded value could not).
 */

test("chrome computed styles derive from the host VendoTheme override", async ({ page }) => {
  // /thread runs under the harness dark theme (background #111827, accent #38bdf8).
  await openScenario(page, "thread");
  const root = page.locator(".vendo-root").first();

  const painted = await root.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      backgroundVar: style.getPropertyValue("--vendo-color-background").trim(),
      accentVar: style.getPropertyValue("--vendo-color-accent").trim(),
    };
  });

  // The painted background is the override, not any built-in default.
  expect(painted.background).toBe("rgb(17, 24, 39)"); // #111827
  expect(painted.backgroundVar).toBe("#111827");
  expect(painted.accentVar).toBe("#38bdf8");

  // A themed primary button paints from the accent variable, resolved.
  const sendAccent = await page.getByRole("button", { name: "Send" }).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(sendAccent).toBe("rgb(56, 189, 248)"); // #38bdf8
});

test("a different host theme diverges — the tree boundary is not hardcoded", async ({ page }) => {
  // /tree-themed applies the loud host theme (accent #7e22ce) to the tree boundary.
  await openScenario(page, "tree-themed");
  const accentVar = await page.locator(".tree-theme-boundary").first().evaluate(element =>
    getComputedStyle(element).getPropertyValue("--vendo-color-accent").trim());
  expect(accentVar).toBe("#7e22ce");
});
