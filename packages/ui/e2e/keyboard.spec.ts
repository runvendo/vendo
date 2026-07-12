import { expect, test } from "@playwright/test";
import { expectKeyboardReachability, openScenario, tabTo } from "./helpers.js";

test("thread is keyboard-complete with visible focus", async ({ page }) => {
  await openScenario(page, "thread");
  await expect(page.getByLabel("Approval for host_email_send")).toBeVisible();
  await expectKeyboardReachability(page, 'main[data-scenario="thread"]');
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === null
    && document.activeElement?.textContent?.trim() === "Approve"));
  await page.keyboard.press("Enter");
  // The composer's accessible name comes from its wrapping <label>, not an
  // aria-label attribute — assert the accessible name, not the attribute.
  await tabTo(page, async () =>
    page.getByRole("textbox", { name: "Message" }).evaluate(element => element === document.activeElement));
  await page.keyboard.type("Keyboard-only turn");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Turn complete")).toBeVisible();
});

test("overlay focus trap and Escape are keyboard-complete", async ({ page }) => {
  await openScenario(page, "overlay");
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
  await expectKeyboardReachability(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  const launcher = page.getByRole("button", { name: "Vendo" });
  await expect(launcher).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
});

test("palette filters and selects with keyboard only", async ({ page }) => {
  await openScenario(page, "palette");
  await expectKeyboardReachability(page, '[role="dialog"]');
  await page.keyboard.type("Invoices");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-recorder")).toContainText('"appId":"app_1"');
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Vendo command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Vendo command palette" })).toBeHidden();
});

test("automation controls are all keyboard reachable and execute by Enter", async ({ page }) => {
  await openScenario(page, "automations");
  await expect(page.getByRole("switch")).toBeVisible();
  await expectKeyboardReachability(page, 'main[data-scenario="automations"]');
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.getAttribute("role") === "switch"));
  const before = await page.getByRole("switch").getAttribute("aria-checked");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  await tabTo(page, async () => page.evaluate(() => document.activeElement?.textContent?.trim() === "Dry run"));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Dry run for Invoice watcher")).toBeVisible();
});
