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
  const door = plain.getByRole("button", { name: "Remix this view with Vendo" });
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
  await expect(panel.getByRole("textbox", { name: "Message" })).toHaveValue("Remix this view: ");
  await expect(page.locator(".fl-remix-ask")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/3-chat-opened.png`, fullPage: true, animations: "disabled" });

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // 4 — the remixed component: its screen took the host original's place, and
  // it carries ONE ✦ menu, which is the pin chrome's.
  await expect(remixed).toContainText("Outstanding this week");
  await expect(remixed).not.toContainText("Recent payees");
  await remixed.hover();
  await remixed.getByRole("button", { name: "Edit this view" }).click();
  const menu = remixed.getByRole("group", { name: "this view" });
  await expect(menu.getByRole("button")).toHaveText(["Edit in chat", "Update", "Revert"]);
  await expect(menu.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/4-remixed-menu.png`, fullPage: true, animations: "disabled" });

  // 5 — and its "Edit in chat" is the same door, about that remix.
  await menu.getByRole("button", { name: "Edit in chat" }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Message" })).toHaveValue("Update this view: ");
  await expect(panel).not.toContainText("app_remix");
  // `slot` is an id too — both sides of the ✦ say the same human words now.
  await expect(panel).not.toContainText("RemixedMerchants");
  await page.screenshot({ path: `${SHOTS}/5-edit-in-chat.png`, fullPage: true, animations: "disabled" });
});

/**
 * The door has to land the person ON the thing they clicked. The first person
 * to walk this cold got the generic landing instead — headline, five starter
 * cards about other things, and their own intent reading as the React
 * identifier `NetWorthView` — and could not tell whether the click had
 * registered on the right component.
 */
test("the ✦ lands on the component, not on a generic assistant", async ({ page }) => {
  await openScenario(page, "remixable");
  const panel = page.getByRole("dialog", { name: "Vendo assistant" });
  const composer = panel.getByRole("textbox", { name: "Message" });
  // The host wires starter cards onto this panel's empty landing (StarterThread
  // in the harness, exactly as the demo host does).
  const starters = panel.locator(".fl-chips button, .fl-cards button");

  const plain = page.locator('[data-vendo-remixable="PlainMerchants"]');
  await plain.hover();
  await plain.getByRole("button", { name: "Remix this view with Vendo" }).click();
  await expect(panel).toBeVisible();

  // The person's own intent reads as words, never as the identifier sync
  // captured the component under — the agent still gets that, out of sight.
  await expect(composer).toHaveValue("Remix this view: ");
  await expect(panel).not.toContainText("PlainMerchants");
  // And nothing on screen argues against it: the starters are about other
  // things, and the person has just said which thing they mean.
  await expect(starters).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/6-door-landing.png`, fullPage: true, animations: "disabled" });

  // The contrast, in the same panel: take the intent away and the host's
  // starters are exactly where they always were.
  await composer.fill("");
  await expect(starters.first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/7-generic-landing.png`, fullPage: true, animations: "disabled" });
});

/**
 * A remix that never built. The seed row is listable and `open` answers the
 * terminal `failed` envelope, both from the wire fixture — the order a real
 * failure arrives in — so the ✦ is the remix's chrome sitting over the host's
 * own untouched markup. It read a settled "Edit", offering to edit a screen
 * that does not exist, beside the agent's own "that remix failed" in the chat.
 */
test("the ✦ does not offer to edit a screen the build never produced", async ({ page }) => {
  await openScenario(page, "remixable");
  const failed = page.locator('[data-vendo-remixable="FailedMerchants"]');
  const pill = failed.locator(".fl-remix-pill");

  // The host's own component is still the content — that part was always right.
  await expect(failed).toContainText("Netflix · $15.49");
  await expect(pill).toHaveText(/Didn’t load/);
  await expect(pill).toHaveAttribute("aria-label", "This view didn’t load");
  await expect(pill).not.toHaveAttribute("aria-busy", "true");

  await failed.hover();
  await pill.click();
  const menu = failed.getByRole("group", { name: "this view" });
  // Announced, and it points at the chat rather than becoming a second place
  // that explains — the developer sentence never reaches the page.
  await expect(menu.getByRole("status")).toHaveText(/didn’t load/i);
  await expect(failed).not.toContainText("sum(spending.data.amount)");
  await expect(failed).not.toContainText("DataTable");
  await page.screenshot({ path: `${SHOTS}/9-failed-remix.png`, fullPage: true, animations: "disabled" });
});

/**
 * Touch has no hover, and a finger's `pointerleave` fires the instant it lifts
 * — so the reveal's leave rule, written for a cursor, took the door away 200ms
 * after the tap that asked for it while CSS left the pill non-interactive.
 * jsdom cannot say this: it ships no PointerEvent, so it cannot tell a finger
 * from a cursor. A real touchscreen context can.
 */
test.describe("on a touchscreen", () => {
  test.use({ hasTouch: true });

  test("a tap reveals the ✦ door, and the lift does not take it away", async ({ page }) => {
    await openScenario(page, "remixable");
    const plain = page.locator('[data-vendo-remixable="PlainMerchants"]');
    const door = plain.getByRole("button", { name: "Remix this view with Vendo" });

    await plain.tap();
    await expect(plain).toHaveAttribute("data-vendo-revealed", "");
    // The finger is already off the glass. Well past the 200ms grace, the door
    // is still there and still pressable.
    await page.waitForTimeout(600);
    await expect(plain).toHaveAttribute("data-vendo-revealed", "");
    await expect(door).toHaveCSS("pointer-events", "auto");
    await page.screenshot({ path: `${SHOTS}/8-touch-revealed.png`, fullPage: true, animations: "disabled" });

    await door.tap();
    await expect(page.getByRole("dialog", { name: "Vendo assistant" })).toBeVisible();

    // And it still puts itself away — a press outside, the way every ✦ does.
    await page.keyboard.press("Escape");
    await page.locator("body").tap({ position: { x: 5, y: 5 } });
    await expect(plain).not.toHaveAttribute("data-vendo-revealed", "");
  });
});
