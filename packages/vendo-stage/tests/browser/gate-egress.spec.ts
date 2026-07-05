import { test, expect } from "@playwright/test";

test("gate 1b: network egress (fetch + image) is blocked by CSP", async ({ page }) => {
  await page.goto("/fixtures/host.html");
  // Wait for the iframe to boot (ready notification sets status to "ready")
  await expect(page.locator("#stage-status")).toHaveText("ready", { timeout: 10_000 });

  const frameHandle = await page.$("#vendo-stage");
  const frame = await frameHandle!.contentFrame();

  // Probe fetch from inside the sandbox frame.
  const fetchResult = await frame!.evaluate(async () => {
    try { await fetch("https://example.com/ping"); return "allowed"; }
    catch { return "blocked"; }
  });
  expect(fetchResult).toBe("blocked");

  // Probe Image load from inside the sandbox frame.
  const imgResult = await frame!.evaluate(() => new Promise<string>(res => {
    const img = new Image();
    img.onload = () => res("allowed");
    img.onerror = () => res("blocked");
    img.src = "https://example.com/x.png";
    setTimeout(() => res("blocked"), 3000);
  }));
  expect(imgResult).toBe("blocked");
});
