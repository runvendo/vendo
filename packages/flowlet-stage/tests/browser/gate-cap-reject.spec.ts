import { test, expect } from "@playwright/test";

test(
  "gate capability-reject: a tools/call with a wrong capability token is rejected; no action fires",
  async ({ page }) => {
    await page.goto("/fixtures/host.html?case=action");
    const frame = page.frameLocator("#flowlet-stage");

    // Wait for initialization so the capability map is built.
    await expect(frame.getByTestId("card-btn")).toBeVisible();

    // Find the sandbox frame and post a forged tools/call with the wrong capability.
    const sandboxFrame = page.frames().find((f) => f !== page.mainFrame());
    if (!sandboxFrame) throw new Error("Could not find sandbox frame");

    await sandboxFrame.evaluate(() => {
      parent.postMessage(
        {
          flowlet: true,
          id: "forged-cap-001",
          method: "tools/call",
          params: {
            name: "confirm",
            originNodeId: "c1",
            capability: "WRONG-TOKEN-FORGED",
            payload: {},
          },
        },
        "*",
      );
    });

    // Give the host time to process the message and reject it.
    await page.waitForTimeout(300);

    // The action-log element must NOT exist (no action was honored).
    await expect(page.locator("#action-log")).not.toBeAttached();
  },
);
