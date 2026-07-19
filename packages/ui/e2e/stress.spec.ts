import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-231 — the permanent solidity stress suite. The single dedicated place for
 * the failure modes the pre-existing specs did NOT cover: mid-stream network
 * kill UX, phone viewports, rapid overlay open/close, multi-turn persistence
 * (would have caught the P0), concurrent surfaces, and dark-brand rendering.
 *
 * The other solidity axes keep their own focused specs; these run in the CI
 * gate alongside this one (see ci.yml "UI solidity + stress suite"):
 *   - long threads / windowing → extreme-content.spec.ts
 *   - scroll / stick-to-bottom / jump-to-latest → scroll-management.spec.ts
 *   - token effectiveness / theme divergence → theme.spec.ts
 *   - bounded height chain → height-chain.spec.ts
 *   - affordances + voice feature verification → verification-eng225/229.spec.ts
 * The axe / keyboard / raw-interaction / screenshot specs stay the LOCAL pre-PR
 * gate — headless CI mis-resolves :focus-visible outlines and light-dark(),
 * which those specs assert directly. The full suite runs locally via
 * `pnpm --filter @vendoai/ui test:browser`.
 */

function send(page: import("@playwright/test").Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message" });
  return box.fill(text).then(() => box.press("Enter"));
}

test("mid-stream network kill surfaces a visible error banner with Retry", async ({ page }) => {
  await openScenario(page, "composer");
  await send(page, "[stream-kill] walk me through the welcome flow");
  // The partial delta lands, then the stream drops — the thread must say so
  // visibly (not only via the hidden aria span) and offer Retry (ENG-214).
  const banner = page.locator(".fl-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/didn.t finish/i);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a phone viewport never crushes the thread to one column of characters", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openScenario(page, "page-chat");
  const thread = page.locator(".fl-thread").first();
  await expect(thread).toBeVisible();
  // ENG-228: below the breakpoint the sidebar+thread two-column grid stacks, so
  // the conversation keeps a usable width instead of the 1-char-per-line brick.
  const width = await thread.evaluate(node => node.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(280);
});

test("rapid overlay open/close never dumps focus to the body or leaves a ghost dialog", async ({ page }) => {
  await openScenario(page, "overlay-manual");
  const launcher = page.getByRole("button", { name: "Vendo" });
  for (let i = 0; i < 6; i += 1) {
    await launcher.click();
    await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeHidden();
    // Focus restores to the launcher, never to <body> (ENG-220).
    await expect(launcher).toBeFocused();
  }
});

test("a sent conversation persists across a reload (the P0 regression guard)", async ({ page }) => {
  await openScenario(page, "page-chat");
  // Start a NEW conversation so the send mints a fresh server thread (rather
  // than appending to the seeded one), then send a turn the server persists
  // under that minted id (ENG-211/222).
  await page.getByRole("button", { name: "New conversation" }).click();
  await send(page, "what happened to my money this month");
  await expect(page.getByText("what happened to my money this month")).toBeVisible();
  await expect(page.getByText("Turn complete").first()).toBeVisible();

  // Reload and reopen the workspace: the minted thread is the newest, so the
  // sidebar re-selects it and reloads its history — the exact failure the P0 (a
  // NEW thread every turn) produced was a blank reload with the turn lost.
  await page.reload();
  await openScenario(page, "page-chat");
  await expect(page.getByText("what happened to my money this month")).toBeVisible();
});

test("concurrent surfaces coexist: the palette keybinding stays a singleton", async ({ page }) => {
  await openScenario(page, "concurrent");
  // A filled slot and a live thread render together with no collision.
  await expect(page.getByText("Outstanding this week")).toBeVisible();
  // One ⌘K opens exactly ONE palette even with several providers on the page.
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Vendo command palette" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Vendo command palette" })).toBeHidden();
});

test("dark-brand host renders readable chrome (light-dark derives from background)", async ({ page }) => {
  await openScenario(page, "page-chat-dark");
  const thread = page.locator(".fl-thread").first();
  await expect(thread).toBeVisible();
  // The chrome derives its scheme from the host background luminance (ENG-226):
  // a dark brand background flips --vendo-color-scheme to "dark", which drives
  // every light-dark() branch in the sheet.
  const scheme = await page.locator(".vendo-root").first().evaluate(node =>
    getComputedStyle(node).getPropertyValue("--vendo-color-scheme").trim(),
  );
  expect(scheme).toBe("dark");
  // And the rendered thread text is actually light (real contrast, not the
  // light-scheme ink on a dark surface).
  const luminance = await thread.evaluate(node => {
    const match = getComputedStyle(node).color.match(/\d+/g);
    if (!match) return 0;
    const [r, g, b] = match.map(Number) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  expect(luminance).toBeGreaterThan(140);
});
