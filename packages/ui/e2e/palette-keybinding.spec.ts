import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

test("palette opens via the keybinding (singleton)", async ({ page }) => {
  // The /palette scenario focuses a host button then dispatches ⌘K; the shared
  // singleton listener opens exactly one conversation surface (one-surface ⌘K —
  // the palette is headless). The overlay's command CHIP STRIP was deleted on
  // 2026-07-23 as clutter, so there is no toolbar to assert any more; the
  // registry seam survives without UI.
  await openScenario(page, "palette");
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("palette does NOT hijack ⌘K while a host input is focused", async ({ page }) => {
  await openScenario(page, "palette-host");
  await page.getByRole("textbox", { name: "Host search" }).click();
  await page.keyboard.press("Meta+k");
  // The host keeps its own ⌘K — no Vendo surface appears, focus stays in the field.
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Host search" })).toBeFocused();
});
