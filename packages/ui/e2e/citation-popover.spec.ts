import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * Knowledge K1 — the citation card portals to <body> and is placed against its
 * chip's live rect, so what this asserts is the two things the old
 * in-transcript card could not do: escape the message list's `overflow: auto`
 * instead of being cropped by it, and open ABOVE its chip when there is no room
 * below — the common case, since a grounded turn's chips sit near the composer.
 */

const card = ".fl-cite-pop--open";

test("the card is a body-level surface, not a descendant of its chip", async ({ page }) => {
  await openScenario(page, "thread-citations");
  await page.locator(".fl-cite-btn").first().click();
  await expect(page.locator(card)).toBeVisible();

  expect(
    await page.locator(card).evaluate(node => node.parentElement?.tagName ?? "?"),
    "a card inside the scroller is a card the scroller can crop",
  ).toBe("BODY");
  expect(await page.locator(card).evaluate(node => getComputedStyle(node).position)).toBe("fixed");
});

test("the card opens above its chip when there is no room below", async ({ page }) => {
  await openScenario(page, "thread-citations");
  // The last turn's chips, with the transcript at its end: the position every
  // grounded answer's sources land in once the reader is caught up.
  await page.locator(".fl-msglist").evaluate(node => { node.scrollTop = node.scrollHeight; });
  const chip = page.locator(".fl-cite-btn").last();
  const chipBox = (await chip.boundingBox())!;

  // Hover, not click: the mouse cannot scroll the chip out from under itself,
  // so the geometry asserted below is the geometry the reader sees.
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await expect(page.locator(card)).toBeVisible();

  const cardBox = (await page.locator(card).boundingBox())!;
  const room = page.viewportSize()!.height - (chipBox.y + chipBox.height);
  expect(room, "the fixture must not leave room below, or this asserts nothing")
    .toBeLessThan(cardBox.height);
  expect(cardBox.y + cardBox.height, "the card sits above the chip it belongs to")
    .toBeLessThanOrEqual(chipBox.y);
  expect(cardBox.y, "…and stays on screen").toBeGreaterThanOrEqual(0);
});
