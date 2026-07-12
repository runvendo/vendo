import { expect, test } from "@playwright/test";
import { openScenario } from "./helpers.js";

/**
 * 06-apps §9 + the one security rule: a rung-4 app frame must never hold host
 * authority. The machine URL is the sandbox provider's, always cross-origin
 * (09 §3), so `allow-same-origin` there gives the app only ITS OWN origin. But
 * a SAME-ORIGIN url + `allow-scripts allow-same-origin` would run the app in the
 * HOST origin with full access to host storage/cookies/APIs. AppFrame grants
 * `allow-same-origin` only for cross-origin urls; a same-origin url runs opaque.
 *
 * (Reported by Greptile with a live repro — this test is the regression guard.)
 */
test("AppFrame withholds same-origin privilege from a same-origin machine url", async ({ page }) => {
  await openScenario(page, "appframe");

  const sameOrigin = page.locator('section[aria-label="HTTP app frame same-origin"] iframe');
  const crossOrigin = page.locator('section[aria-label="HTTP app frame cross-origin"] iframe');

  // A same-origin (relative) url must NOT be granted allow-same-origin.
  const sameSandbox = await sameOrigin.getAttribute("sandbox");
  expect(sameSandbox).toBe("allow-scripts allow-forms");

  // A genuine cross-origin machine url keeps allow-same-origin (its own origin).
  const crossSandbox = await crossOrigin.getAttribute("sandbox");
  expect(crossSandbox).toContain("allow-same-origin");

  // And the same-origin frame proves it at runtime: opaque origin → no host storage.
  const framed = page.frameLocator('section[aria-label="HTTP app frame same-origin"] iframe');
  await expect(framed.locator("#origin-probe")).toHaveText("origin: OPAQUE (storage denied)");

  // The host's own storage was never touched by the framed app.
  const leaked = await page.evaluate(() => window.localStorage.getItem("vendo-appframe-probe"));
  expect(leaked).toBeNull();
});
