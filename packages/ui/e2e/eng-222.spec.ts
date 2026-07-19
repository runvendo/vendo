import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/** ENG-222 verification shots — committed under docs/verification/eng-222 and
 *  referenced from the PR body (UI LAW: real-browser proof, not just tests). */
const shotPath = (file: string) =>
  new URL(`../../../docs/verification/eng-222/${file}.png`, import.meta.url).pathname;

test("palette opens via the keybinding (singleton)", async ({ page }) => {
  // The /palette scenario focuses a host button then dispatches ⌘K; the shared
  // singleton listener opens exactly one conversation surface (one-surface ⌘K
  // — the palette is headless and its commands ride the overlay chip strip).
  await openScenario(page, "palette");
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toHaveCount(1);
  await expect(page.getByRole("toolbar", { name: "Commands" })).toBeVisible();
  await page.screenshot({ path: shotPath("palette-keybinding"), fullPage: true, animations: "disabled" });
});

test("palette does NOT hijack ⌘K while a host input is focused", async ({ page }) => {
  await openScenario(page, "palette-host");
  await page.getByRole("textbox", { name: "Host search" }).click();
  await page.keyboard.press("Meta+k");
  // The host keeps its own ⌘K — no Vendo surface appears, focus stays in the field.
  await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Host search" })).toBeFocused();
  await page.screenshot({ path: shotPath("palette-no-hijack"), fullPage: true, animations: "disabled" });
});

async function newConversationAppears(page: import("@playwright/test").Page) {
  const list = page.getByRole("button", { name: "Fixture thread" });
  // At least one existing conversation has loaded into the sidebar (the shared
  // harness server may already carry threads minted by an earlier scenario).
  await expect.poll(async () => (await list.count()) >= 1).toBe(true);
  const before = await list.count();
  // This spec asserts the returning-user landing heading; a first-ever fresh
  // conversation shows the one-time greeting-as-tutorial instead
  // (discoverability §6), so mark it already seen for this origin.
  await page.evaluate(() => localStorage.setItem("vendo:discoverability:greeting", "1"));
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("heading", { name: "What can I help you build?" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Plan my week");
  await page.getByRole("button", { name: "Send" }).click();
  // The freshly minted conversation is pulled into the sidebar by the refresh.
  await expect(list).toHaveCount(before + 1);
}

test("page thread sidebar refreshes with a new conversation (light)", async ({ page }) => {
  await openScenario(page, "page-chat");
  await newConversationAppears(page);
  await page.screenshot({ path: shotPath("page-thread-sidebar-light"), fullPage: true, animations: "disabled" });
});

test("page thread sidebar refreshes with a new conversation (dark)", async ({ page }) => {
  await openScenario(page, "page-chat-dark");
  await newConversationAppears(page);
  await page.screenshot({ path: shotPath("page-thread-sidebar-dark"), fullPage: true, animations: "disabled" });
});
