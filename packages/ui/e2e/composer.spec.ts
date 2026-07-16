import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

// ENG-215 — composer behaviors proven in a real browser (real layout for
// autogrow, a real streamed turn for the queued-send window).

test("textarea autogrows with content and caps at its max-height", async ({ page }) => {
  await openScenario(page, "composer");
  const textarea = page.getByRole("textbox", { name: "Message" });
  const heightOf = () => textarea.evaluate(node => node.getBoundingClientRect().height);

  const oneLine = await heightOf();
  await textarea.fill(Array.from({ length: 6 }, (_, i) => `Line ${i + 1} of a growing draft`).join("\n"));
  const sixLines = await heightOf();
  expect(sixLines).toBeGreaterThan(oneLine + 20);

  // Way past the cap — the element stops growing and scrolls internally.
  await textarea.fill(Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n"));
  const capped = await heightOf();
  expect(capped).toBeLessThanOrEqual(210); // CSS max-height is 200px

  await textarea.fill("");
  const reset = await heightOf();
  expect(reset).toBeLessThan(sixLines);
});

test("typing stays live while a turn streams, and a mid-turn send queues then auto-sends", async ({ page }) => {
  await openScenario(page, "composer");
  const textarea = page.getByRole("textbox", { name: "Message" });

  // A long paced turn gives a real streaming window to act inside.
  await textarea.fill("[stream-long] walk me through the welcome flow in detail");
  await page.getByRole("button", { name: "Send" }).click();

  // Streaming: Stop appears, and the composer is still typeable (not disabled).
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(textarea).toBeEnabled();
  await textarea.fill("And add a PS about the mobile app");
  await page.getByRole("button", { name: "Send" }).click();

  // It parks as a visible queued pill, and the input clears.
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("And add a PS about the mobile app")).toBeVisible();
  await expect(textarea).toHaveValue("");

  // When the long turn finishes, the queued message auto-sends as a real turn
  // and the pill disappears.
  await expect(page.getByText("Long turn complete.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Queued", { exact: true })).toBeHidden();
  await expect(page.locator(".fl-usertext", { hasText: "And add a PS about the mobile app" })).toBeVisible();
});

test("edit last message refills the composer and drops the turn", async ({ page }) => {
  await openScenario(page, "composer");
  const turn = page.locator(".fl-usertext", { hasText: "Draft a friendly welcome email" });
  await expect(turn).toBeVisible();
  await turn.hover();
  await page.getByRole("button", { name: "Edit message" }).click();

  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Draft a friendly welcome email for new Maple customers.");
  await expect(page.locator(".fl-usertext", { hasText: "Draft a friendly welcome email" })).toBeHidden();
});

test("regenerate re-issues the last assistant response", async ({ page }) => {
  await openScenario(page, "composer");
  const assistant = page.locator(".fl-turn-assistant").last();
  await assistant.hover();
  await page.getByRole("button", { name: "Regenerate" }).click();
  // The wire streams a fresh turn ending in "Turn complete".
  await expect(page.getByText("Turn complete")).toBeVisible();
});
