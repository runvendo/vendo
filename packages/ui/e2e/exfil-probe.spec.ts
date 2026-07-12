import { expect, test } from "@playwright/test";
import { jailFrame, openScenario } from "./helpers.js";

/**
 * 08-ui §5 — the jail's promise is that generated code cannot reach the network.
 * `connect-src 'none'` closes fetch/XHR/WebSocket/sendBeacon and `img-src data:`
 * closes pixel beacons, but NAVIGATING THE FRAME ITSELF is governed by neither,
 * and the sandbox's form/popup flags don't touch it. The nested-frame jail closes
 * it (the embedder's frame-src governs the inner frame's navigations); this test
 * is the proof, and it must never be weakened.
 *
 * The assertion is on the wire, not on any API's return value: `sendBeacon`
 * returns true when a beacon is merely QUEUED and says nothing about whether CSP
 * later dropped it. Only a response/finished event proves bytes left the browser.
 */
test("no exfiltration channel out of the jail: navigation, beacon, image", async ({ page }) => {
  const egressed: string[] = [];
  page.on("response", r => { if (r.url().includes("example.com")) egressed.push(`response ${r.status()} ${r.url()}`); });
  page.on("requestfinished", r => { if (r.url().includes("example.com")) egressed.push(`finished ${r.url()}`); });

  await openScenario(page, "tree-jail");
  const jail = jailFrame(page, "SecurityProbe");
  await expect(jail.getByRole("heading", { name: "Rendered generated props" })).toBeVisible();

  // Every network-capable API a generated component could reach for, one by one.
  await jail.getByRole("button", { name: "Probe xhr" }).click();
  await expect(jail.locator("#xhr-status")).toHaveText("xhr: FAILURE (CSP)");
  await jail.getByRole("button", { name: "Probe socket" }).click();
  await expect(jail.locator("#socket-status")).toHaveText("socket: FAILURE (CSP)");
  await jail.getByRole("button", { name: "Probe beacon" }).click();
  await jail.getByRole("button", { name: "Probe image" }).click();
  await expect(jail.locator("#image-status")).toHaveText("image: FAILURE (CSP)");
  await jail.getByRole("button", { name: "Probe navigate" }).click();

  // Give every queued/async channel a real chance to leave the browser.
  await page.waitForTimeout(1_500);

  expect(egressed, "generated code must not reach the network by ANY channel").toEqual([]);
});
