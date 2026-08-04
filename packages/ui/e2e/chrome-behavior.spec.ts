import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

test("thread sends a real streamed turn and renders the assistant delta", async ({ page }) => {
  await openScenario(page, "thread");
  await expect(page.getByLabel("Approval for Email send")).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Send the browser fixture email");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Turn complete")).toBeVisible();
  // ENG-216 — the humanized label, asserted where it actually renders. The old
  // `.fl-tool-label` progress chip was deleted with the tool-chip strip; the
  // approval card is now the only surface carrying this tool's name, and the
  // raw slug must never reach the page. (Two cards by the end of the turn: the
  // thread's pre-parked ask plus the one this turn raised.)
  await expect(page.getByLabel("Approval for Email send").first()).toBeVisible();
  await expect(page.getByText("host_email_send")).toHaveCount(0);
});

test("overlay traps focus, closes on Escape, and restores the launcher", async ({ page }) => {
  await openScenario(page, "overlay");
  const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
  const close = page.getByRole("button", { name: "Close Vendo" });
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(dialog).toBeVisible();
  // ENG-220: initial focus lands in the composer, not on the close button.
  await expect(composer).toBeFocused();
  // The trap, not a fixed tab order: the panel has grown controls since this
  // spec pinned "one Tab reaches Close", so assert the actual contract —
  // Tab NEVER leaves the dialog, and Close is reachable inside it.
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() =>
        document.activeElement?.closest('[role="dialog"][aria-label="Vendo assistant"]') !== null))
      .toBe(true);
  }
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "AI agent" })).toBeFocused();
});

// Deleted 2026-08-03 (lane G triage): "⌘K chip strip records the selected
// public command". The command chip strip above the composer was deliberately
// removed on 2026-07-23 (see vendo-overlay.tsx — "it read as clutter and
// duplicated app entry points"); the command REGISTRY seam it exercised has no
// UI left to click. What survives — ⌘K opens exactly one surface, and the
// keybinding toggles it — is covered by eng-222.spec.ts and keyboard.spec.ts.

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
  // The risk chip speaks the user's language — the raw wire slug is only the
  // chip's title attribute (RISK_LABEL, approval-card.tsx).
  await expect(page.getByText("Irreversible", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Real tool inputs")).toContainText("Permanent");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("approval-recorder")).toHaveText('resolved: {"approve":true}');
  await expect(page.getByLabel("Approval for Delete invoice")).toBeHidden();
});

test("ENG-216 humanizes the approval, hides raw slugs, and fixes fabricated ctx", async ({ page }) => {
  await openScenario(page, "thread-humanized");

  // No raw slug and no ai-SDK lifecycle string ever reaches the surface.
  await expect(page.getByText(/host_list_client_documents/)).toHaveCount(0);
  await expect(page.getByText("output-available")).toHaveCount(0);

  // The approval card shows the friendly title + description and readable
  // inputs. Fields render as label/value ROWS (`flatFields`), so the assertion
  // reads them as the DOM has them, not as the old "Label: value" string.
  const card = page.getByLabel("Approval for Transfer funds");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Move money between the customer's accounts");
  await expect(card.getByRole("term").filter({ hasText: "Amount" })).toBeVisible();
  await expect(card.getByRole("definition").filter({ hasText: "4200" })).toBeVisible();

  // Fabricated in-thread ctx byline (venue · presence) is gone.
  await expect(page.getByText("chat · present")).toHaveCount(0);

  // The humanized tool-chip assertions that used to live here targeted
  // `.fl-tool-label` / `.fl-tool-count` — classes NO component renders (the
  // chip strip was replaced by the StatusRibbon under lane pick C1, and beats
  // return to the transcript under the 2026-08-03 supersession). Re-assert the
  // "Look up client documents ×8" collapse there, on the beat, once it lands.
});
