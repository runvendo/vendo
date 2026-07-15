import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * ENG-212 — .vendo-root must join the host's height chain.
 *
 * Measured live on Cadence /assistant: the ui-owned .vendo-root wrapper sat as
 * an unconstrained block between the host's bounded flex pane and .fl-thread
 * (height:100%), so .fl-msglist never got a bounded height. Under an
 * overflow:hidden host the composer and every approval action rendered below
 * the clip with no scroll possible. The /thread-bounded scenario reproduces
 * that exact host shape with a long conversation ending in a pending approval.
 */

test.beforeEach(async ({ page }) => {
  await openScenario(page, "thread-bounded");
  // The long fixture thread has loaded once the last turn's approval exists
  // (visible-to-Playwright even when clipped by the pane's overflow:hidden).
  await expect(page.getByLabel("Approval for host_email_send")).toBeVisible();
});

test("the root forwards the pane's bounded height to the thread", async ({ page }) => {
  const pane = page.getByTestId("bounded-pane");
  const chain = await pane.evaluate(node => {
    const root = node.querySelector<HTMLElement>(".vendo-root");
    const thread = node.querySelector<HTMLElement>(".fl-thread");
    return {
      pane: node.clientHeight,
      root: root?.offsetHeight ?? 0,
      thread: thread?.offsetHeight ?? 0,
    };
  });
  // Every link of the chain stays within the pane instead of growing to content.
  expect(chain.root).toBeLessThanOrEqual(chain.pane + 1);
  expect(chain.thread).toBeLessThanOrEqual(chain.pane + 1);
  expect(chain.thread).toBeGreaterThan(0);
});

test("the message list is the scroll container for a long conversation", async ({ page }) => {
  const msglist = page.locator(".fl-msglist");
  await expect(msglist).toBeVisible();
  const metrics = await msglist.evaluate(node => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  expect(metrics.clientHeight).toBeGreaterThan(0);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // And it actually scrolls: setting scrollTop sticks.
  const scrolled = await msglist.evaluate(node => {
    node.scrollTop = 99999;
    return node.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
});

test("composer and approval actions stay reachable under overflow:hidden", async ({ page }) => {
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeInViewport();

  // Approvals render at the end of the list — scroll to latest and act.
  await page.locator(".fl-msglist").evaluate(node => { node.scrollTop = node.scrollHeight; });
  const approve = page.getByRole("button", { name: "Approve" });
  await expect(approve).toBeInViewport();

  // The composer must still sit inside the pane's clip box, not below it.
  const pane = await page.getByTestId("bounded-pane").boundingBox();
  const box = await composer.boundingBox();
  expect(box, "composer must have a layout box").not.toBeNull();
  expect(pane, "pane must have a layout box").not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(pane!.y + pane!.height + 1);
});
