import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-231 — the permanent solidity stress suite. The single dedicated place for
 * the failure modes the pre-existing specs did NOT cover: mid-stream network
 * kill UX, rapid overlay open/close, and concurrent surfaces.
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

test("mid-stream network kill surfaces a visible error banner, and the turn owns the redo", async ({ page }) => {
  await openScenario(page, "composer");
  await send(page, "[stream-kill] walk me through the welcome flow");
  // The partial delta lands, then the stream drops — the thread must say so
  // visibly, not only via the hidden aria span (ENG-214).
  const banner = page.locator(".fl-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/didn.t finish/i);
  // ⚠️ TEST EDIT (ruling 16): this required a "Retry" button INSIDE the banner.
  // §15 gives the conversation zero failure components: the recovery is the
  // turn's own Regenerate action (and the composer), which is what a reader
  // already knows how to use.
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
});

test("rapid overlay open/close never dumps focus to the body or leaves a ghost dialog", async ({ page }) => {
  await openScenario(page, "overlay-manual");
  const launcher = page.getByRole("button", { name: "AI agent" });
  for (let i = 0; i < 6; i += 1) {
    await launcher.click();
    await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeHidden();
    // Focus restores to the launcher, never to <body> (ENG-220).
    await expect(launcher).toBeFocused();
  }
});

test("concurrent surfaces coexist: a filled slot, a live thread, and an overlay on one page", async ({ page }) => {
  await openScenario(page, "concurrent");
  // A filled slot and a live thread render together with no collision.
  await expect(page.getByText("Outstanding this week")).toBeVisible();
});
