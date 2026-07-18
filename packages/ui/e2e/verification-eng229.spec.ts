import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-229 — verification captures (committed to docs/verification/eng-229/).
 * Not a behavioral gate (that is test/voice/*); this spec produces the PR
 * screenshots: the full designed stage with view feed + live consent bar,
 * the transcript drawer, reconnecting + error banners, and dark.
 */

const shotPath = (name: string) =>
  new URL(`../../../docs/verification/eng-229/${name}.png`, import.meta.url).pathname;

test("full stage — feed + consent bar (Maple)", async ({ page }) => {
  await openScenario(page, "stage-full");
  await expect(page.getByRole("heading", { name: "Outstanding this week" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reminder drafts" })).toBeVisible();
  // The wire fixture's parked approval reaches the consent bar while active.
  await expect(page.locator(".fl-voice-consent")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.screenshot({ path: shotPath("01-stage-full-light"), animations: "disabled" });
});

test("transcript drawer opens, Escape restores focus", async ({ page }) => {
  await openScenario(page, "stage-drawer");
  await expect(page.getByRole("heading", { name: "Reminder drafts" })).toBeVisible();
  await page.getByRole("button", { name: "Transcript" }).click();
  await expect(page.locator("#vendo-voice-transcript")).toBeVisible();
  await expect(page.getByLabel("Session transcript").getByText("What's outstanding this week, and draft the reminders?")).toBeVisible();
  await page.screenshot({ path: shotPath("02-transcript-drawer"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#vendo-voice-transcript")).toBeHidden();
  await expect(page.getByRole("button", { name: "Transcript" })).toBeFocused();
});

test("reconnecting banner", async ({ page }) => {
  await openScenario(page, "stage-reconnecting");
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" }).first()).toBeVisible();
  await page.screenshot({ path: shotPath("03-reconnecting"), animations: "disabled" });
});

test("error banner with Retry (no more infinite connecting)", async ({ page }) => {
  await openScenario(page, "stage-error");
  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.screenshot({ path: shotPath("04-error-retry"), animations: "disabled" });
});

test("full stage — dark", async ({ page }) => {
  await openScenario(page, "stage-full-dark");
  await expect(page.getByRole("heading", { name: "Outstanding this week" })).toBeVisible();
  await page.screenshot({ path: shotPath("05-stage-full-dark"), animations: "disabled" });
});

test("mute flips the control and the status copy", async ({ page }) => {
  await openScenario(page, "stage-full");
  await expect(page.getByRole("heading", { name: "Outstanding this week" })).toBeVisible();
  await page.getByRole("button", { name: "Mute" }).click();
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
  await expect(page.getByLabel("Voice status")).toHaveText("Muted");
  await page.screenshot({ path: shotPath("06-muted"), animations: "disabled" });
});
