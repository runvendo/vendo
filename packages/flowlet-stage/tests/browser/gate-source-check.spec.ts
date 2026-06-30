import { test, expect } from "@playwright/test";

test("gate source-check: forged postMessage from top window is ignored by the chokepoint", async ({ page }) => {
  await page.goto("/fixtures/host.html");
  // Wait for stage to be ready.
  await expect(page.locator("#stage-status")).toHaveText("ready", { timeout: 10_000 });

  // Post a forged tools/call directly from the top window (wrong source — not the iframe).
  // If the chokepoint were broken, onAction would write to #action-log.
  await page.evaluate(() => {
    window.postMessage({
      flowlet: true,
      id: "forged-rpc-1",
      method: "tools/call",
      params: {
        name: "confirm",
        originNodeId: "root",
        capability: "anything",
        payload: {},
      },
    }, "*");
  });

  // Give time for the message to be processed.
  await page.waitForTimeout(200);

  // action-log must NOT exist or must be empty (onAction was never called).
  const logText = await page.locator("#action-log").count() > 0
    ? await page.locator("#action-log").textContent()
    : "";
  expect(logText ?? "").toBe("");
});
