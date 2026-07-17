import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

test("thread sends a real streamed turn and renders the assistant delta", async ({ page }) => {
  await openScenario(page, "thread");
  await expect(page.getByLabel("Approval for Email send")).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Send the browser fixture email");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Turn complete")).toBeVisible();
  // ENG-216 — humanized chip label (scoped to the chip class; the approval
  // title also reads "Email send").
  await expect(page.locator(".fl-tool-label").filter({ hasText: "Email send" }).first()).toBeVisible();
});

test("overlay traps focus, closes on Escape, and restores the launcher", async ({ page }) => {
  await openScenario(page, "overlay");
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  const close = page.getByRole("button", { name: "Close Vendo" });
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(dialog).toBeVisible();
  // ENG-220: initial focus lands in the composer, not on the close button.
  await expect(composer).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Vendo" })).toBeFocused();
});

test("palette filters and Enter records the selected public command", async ({ page }) => {
  await openScenario(page, "palette");
  const input = page.getByRole("combobox");
  await expect(input).toBeFocused();
  await input.fill("Invoices");
  await expect(page.getByRole("option", { name: "Open Invoices" })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByTestId("command-recorder")).toContainText('"kind":"open-app"');
  await expect(page.getByTestId("command-recorder")).toContainText('"appId":"app_1"');
});

test("automation toggle and dry run render their wire outcomes", async ({ page }) => {
  await openScenario(page, "automations");
  const toggle = page.getByRole("switch");
  await expect(toggle).toBeVisible();
  const before = await toggle.getAttribute("aria-checked");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(page.getByLabel("Dry run for Invoice watcher")).toContainText("host_invoices_list — ready");
});

test("destructive approval resolves with an approve decision", async ({ page }) => {
  await openScenario(page, "approval");
  await expect(page.getByText("destructive", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Real tool inputs")).toContainText("permanent=true");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("approval-recorder")).toHaveText('resolved: {"approve":true}');
  await expect(page.getByLabel("Approval for Delete invoice")).toBeHidden();
});

test("ENG-216 humanizes tool chips, collapses repeats, and fixes fabricated approval ctx", async ({ page }) => {
  await openScenario(page, "thread-humanized");

  // Host metadata drives friendly chip labels + arg summaries.
  await expect(page.locator(".fl-tool-label").filter({ hasText: "Send email" })).toBeVisible();
  await expect(page.locator(".fl-tool-label").filter({ hasText: "Look up client documents" })).toBeVisible();

  // Eight identical read calls collapse into one chip with a count.
  await expect(page.locator(".fl-tool-label").filter({ hasText: "Look up client documents" })).toHaveCount(1);
  await expect(page.locator(".fl-tool-count")).toHaveText("×8");

  // No raw slug and no ai-SDK lifecycle string ever reaches the surface.
  await expect(page.getByText(/host_list_client_documents/)).toHaveCount(0);
  await expect(page.getByText("output-available")).toHaveCount(0);

  // The approval card shows the friendly title + description and readable inputs.
  const card = page.getByLabel("Approval for Transfer funds");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Move money between the customer's accounts");
  await expect(card).toContainText("Amount: 4200");

  // Fabricated in-thread ctx byline (venue · presence) is gone.
  await expect(page.getByText("chat · present")).toHaveCount(0);
});
