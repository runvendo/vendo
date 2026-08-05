import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * §10.2 mid-build steering, proven in a real browser as a real user does it:
 * ask for something, and while it is still being built, type a correction.
 *
 * `[stream-long]` gives a real ~8s streaming window to act inside; `[steerable]`
 * is the fixture's per-turn opt-in for a turn that can take the message (the
 * real product's answer comes from the harness, not a flag).
 */
test("a correction typed mid-build joins the build, and the build visibly changes course", async ({ page }) => {
  // §10.2's heavy-build surface — the split-view workspace, which is the
  // mockup's scene 3. Beats accumulate durably in the rail here, so the
  // course-change is visible rather than a transient ribbon between text gaps.
  await openScenario(page, "overlay");
  await page.getByRole("button", { name: "Expand workspace" }).click();
  const textarea = page.getByRole("textbox", { name: "Message" });

  await textarea.fill("[steerable] [stream-long] build me a reconciliation workbench");
  await page.getByRole("button", { name: "Send" }).click();

  // The build is under way: Stop is offered and the composer stays typeable.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(textarea).toBeEnabled();

  // The correction, typed while the build runs.
  await textarea.fill("group by client instead");
  await page.getByRole("button", { name: "Send" }).click();

  // It landed IN the running turn: the chip reports delivery, and the words are
  // in the transcript as a normal user turn.
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByText("added to the reply in progress")).toBeVisible();
  await expect(page.locator(".fl-usertext", { hasText: "group by client instead" })).toBeVisible();
  // Steering never cancels: the build is still running.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // THE COURSE-CHANGE, visible: the steered rework narrates a fresh beat into the
  // same open turn stream (Yousef's real-user rule). The fixture cannot re-plan,
  // so it mirrors the real box's causal chain — steer → a new `building` beat —
  // rather than inventing new planning.
  await expect(page.locator(".fl-beatrail .fl-beat-label", { hasText: "Regrouping by client" }))
    .toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: screenshotPath("steering-landed-mid-build"), fullPage: true });

  // The build finishes on its own — the steer never became a second turn.
  await expect(page.getByText("Long turn complete.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  // Still exactly one copy of the words: in the transcript, never re-sent.
  const steerTurn = page.locator(".fl-usertext", { hasText: "group by client instead" });
  await expect(steerTurn).toHaveCount(1);
  await steerTurn.scrollIntoViewIfNeeded();
  await expect(steerTurn).toBeVisible();
  await page.screenshot({ path: screenshotPath("steering-settled-in-history"), fullPage: true });
});

test("without a steerable turn the message still queues and sends at the end, unchanged", async ({ page }) => {
  await openScenario(page, "composer");
  const textarea = page.getByRole("textbox", { name: "Message" });

  // No `[steerable]`: this turn cannot take a mid-build message.
  await textarea.fill("[stream-long] walk me through the welcome flow");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await textarea.fill("and add a PS about the mobile app");
  await page.getByRole("button", { name: "Send" }).click();

  // Today's behaviour, untouched: it waits, and says so.
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("sends when the reply finishes")).toBeVisible();
  await page.screenshot({ path: screenshotPath("steering-fallback-queued"), fullPage: true });

  await expect(page.getByText("Long turn complete.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Queued", { exact: true })).toBeHidden();
  await expect(page.locator(".fl-usertext", { hasText: "and add a PS about the mobile app" })).toBeVisible();
});
