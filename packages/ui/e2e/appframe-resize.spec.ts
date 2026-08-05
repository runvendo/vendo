import { expect, test } from "@playwright/test";
import { openScenario, screenshotPath } from "./helpers.js";

/**
 * The frame resize protocol, host half (blueprint §12.3) — verified in a real
 * browser, because the property under test is layout: what the box does when the
 * app inside it asks to be a different size.
 *
 * The served app half ships in the served-app template; `/resize-target.html`
 * stands in for it here, reporting its natural height over the jail runtime's
 * exact message shape (`{ vendo: true, kind: "resize", height }`).
 *
 * THE HOST'S BOUNDS WIN. The host sized the slot when it embedded Vendo. The app
 * reports; the frame fits that report inside the host's min/max; an app taller
 * than the host allows scrolls inside its own frame and never pushes the host's
 * layout.
 */

const frameIn = (label: string) => `section[aria-label="${label}"] iframe`;

test.beforeEach(async ({ page }) => {
  await openScenario(page, "appframe-resize");
  // Every fixture frame has reported and been fitted.
  await expect(page.locator(frameIn("Reported height honoured"))).toHaveJSProperty("clientHeight", 640);
});

test("the frame grows to the height the app reported", async ({ page }) => {
  const frame = page.locator(frameIn("Reported height honoured"));
  const box = await frame.boundingBox();
  expect(box!.height).toBe(640);
  // Nothing is clipped when the host allows the reported height: the app's own
  // document has nothing left to scroll.
  const fit = await page.frameLocator(frameIn("Reported height honoured")).locator("body")
    .evaluate((body) => {
      const doc = body.ownerDocument.documentElement;
      return { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight };
    });
  expect(fit.scrollHeight).toBe(fit.clientHeight);
  await page.locator('section[aria-label="Reported height honoured"]')
    .screenshot({ path: screenshotPath("appframe-resize-grows") });
});

test("the host's max caps the frame, and the overflow scrolls INSIDE it", async ({ page }) => {
  const selector = frameIn("Host max height wins");
  const frame = page.locator(selector);
  // The app asked for 1600px; the host's slot allows 420px.
  await expect(frame).toHaveJSProperty("clientHeight", 420);
  expect((await frame.boundingBox())!.height).toBe(420);

  // The host's own box did not grow to the app's 1600px — its layout is intact.
  // The section is the 420px frame plus its own heading and padding; had the app
  // pushed the host's layout it would be 1600px plus that same chrome.
  const section = page.locator('section[aria-label="Host max height wins"]');
  expect((await section.boundingBox())!.height).toBeLessThan(420 + 200);
  await section.scrollIntoViewIfNeeded();
  // The capped frame as the user first meets it: the app's top, cut at the host's
  // ceiling rather than spilling down the host's page.
  await section.screenshot({ path: screenshotPath("appframe-resize-host-max") });

  // And the app is not truncated: its own document scrolls.
  const framed = page.frameLocator(selector);
  const scroll = await framed.locator("body").evaluate((body) => {
    const doc = body.ownerDocument.documentElement;
    doc.scrollTop = 99_999;
    return { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight, scrollTop: doc.scrollTop };
  });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.scrollTop).toBeGreaterThan(0);

  // The page itself never gained a scrollbar from the app's ambition.
  const page1600 = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(page1600.scrollHeight).toBeLessThan(page1600.clientHeight + 1_600);

  // The same 420px box, scrolled INSIDE to the bottom of 1600px of app content.
  await section.screenshot({ path: screenshotPath("appframe-resize-scrolls-inside") });
});

test("the host's reserved minimum survives an app that reports less", async ({ page }) => {
  // 80px reported, `--vendo-app-frame-height` default 320px reserved.
  await expect(page.locator(frameIn("Host min height wins"))).toHaveJSProperty("clientHeight", 320);
});

test("a resize from any other window changes nothing (the identity gate)", async ({ page }) => {
  const grown = page.locator(frameIn("Reported height honoured"));
  const capped = page.locator(frameIn("Host max height wins"));
  const reserved = page.locator(frameIn("Host min height wins"));

  // Each frame kept its OWN report even though all three posted to the same host
  // page — the host discriminates by sending window, not by message content.
  await expect(grown).toHaveJSProperty("clientHeight", 640);
  await expect(capped).toHaveJSProperty("clientHeight", 420);
  await expect(reserved).toHaveJSProperty("clientHeight", 320);

  // Now the host page itself sends a perfectly well-formed, correctly stamped
  // resize. It is not any of these frames, so it resizes none of them.
  const section = page.locator('section[aria-label="Reported height honoured"]');
  const before = await section.screenshot({ path: screenshotPath("appframe-resize-spoof-before") });
  await page.evaluate(() => {
    window.postMessage({ vendo: true, kind: "resize", height: 2_000 }, "*");
  });
  await page.waitForTimeout(250);
  await expect(grown).toHaveJSProperty("clientHeight", 640);
  await expect(capped).toHaveJSProperty("clientHeight", 420);
  await expect(reserved).toHaveJSProperty("clientHeight", 320);

  // Not "close enough": the slot is pixel-for-pixel the frame it was before the
  // spoof arrived.
  const after = await section.screenshot({ path: screenshotPath("appframe-resize-spoof-after") });
  expect(after.equals(before)).toBe(true);
});
