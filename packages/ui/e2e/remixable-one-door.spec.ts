import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * S2 — the ✦ is ONE DOOR. The wish used to be typed into a form the wrapper
 * drew itself, which the chat knew nothing about; now the mark opens the
 * conversation the page already has, and a remixed component wears the pin
 * chrome's single menu instead of a lookalike of it.
 *
 * A real browser, because the bloom is a CSS reveal and the popover is real
 * layout: jsdom cannot say whether the pill can actually be hovered to.
 */
const SHOTS = "/tmp/s2-shots";

test("the ✦ opens the chat about the component, and the remixed one wears the pin chrome", async ({ page }) => {
  await openScenario(page, "remixable");

  const plain = page.locator('[data-vendo-remixable="PlainMerchants"]');
  const remixed = page.locator('[data-vendo-remixable="RemixedMerchants"]');

  // 1 — at rest: the 9px seed, and a pill nobody can press by accident.
  const door = plain.getByRole("button", { name: "Remix PlainMerchants with Vendo" });
  await expect(plain.locator(".fl-remix-seed")).toHaveCSS("opacity", "0.32");
  await expect(door).toHaveCSS("opacity", "0");
  await expect(door).toHaveCSS("pointer-events", "none");
  await page.screenshot({ path: `${SHOTS}/1-at-rest.png`, fullPage: true, animations: "disabled" });

  // 2 — hovering blooms the seed into the pill, in place.
  await plain.hover();
  await expect(plain).toHaveAttribute("data-vendo-revealed", "");
  await expect(door).toHaveCSS("opacity", "1");
  await page.screenshot({ path: `${SHOTS}/2-bloomed.png`, fullPage: true, animations: "disabled" });

  // 3 — the door: one press lands in the conversation, prefilled and unsent.
  // No wish form of its own anywhere on the page.
  await door.click();
  const panel = page.getByRole("dialog", { name: "Vendo assistant" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Message" })).toHaveValue("Remix my PlainMerchants: ");
  await expect(page.locator(".fl-remix-ask")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/3-chat-opened.png`, fullPage: true, animations: "disabled" });

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // 4 — the remixed component: its screen took the host original's place, and
  // it carries ONE ✦ menu, which is the pin chrome's.
  await expect(remixed).toContainText("Outstanding this week");
  await expect(remixed).not.toContainText("Recent payees");
  await remixed.hover();
  await remixed.getByRole("button", { name: "Edit RemixedMerchants" }).click();
  const menu = remixed.getByRole("group", { name: "RemixedMerchants" });
  await expect(menu.getByRole("button")).toHaveText(["Edit in chat", "Update", "Revert"]);
  await expect(menu.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/4-remixed-menu.png`, fullPage: true, animations: "disabled" });

  // 5 — and its "Edit in chat" is the same door, about that remix.
  await menu.getByRole("button", { name: "Edit in chat" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Message" })).toHaveValue("Update RemixedMerchants: ");
  await expect(panel).not.toContainText("app_remix");
  await page.screenshot({ path: `${SHOTS}/5-edit-in-chat.png`, fullPage: true, animations: "disabled" });
});
