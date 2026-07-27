// speed-core lane (criterion 7) — capture the live Maple create UX off the
// REAL demo-bank surface: login → open Vendo (launcher) → type an off-script
// prompt → record until the app completes. The recording must show first
// visual paint ≤ 5s and staged progress (never a static spinner).
// Prereqs: demo-bank dev on :3000 (MAPLE_STORE=local); run FROM THE REPO ROOT
// (module + output paths resolve from cwd).
// Usage: node docs/verification/demo-live-readiness/speed-core/capture-maple-speed.mjs [out.webm] ["prompt text"]
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const requireFromUi = createRequire(resolve("packages/ui/package.json"));
const { chromium } = requireFromUi("@playwright/test");

const BASE = process.env.MAPLE_URL ?? "http://localhost:3000";
const OUT = resolve(process.argv[2] ?? "docs/verification/demo-live-readiness/speed-core/maple-create-ux.webm");
const PROMPT = process.argv[3]
  ?? "Put together a weekend spending review: what I spent on food and fun last week, versus my budgets.";

const videoDir = mkdtempSync(join(tmpdir(), "vendo-speed-"));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

await page.goto(`${BASE}/login`);
if (page.url().includes("/login")) {
  await page.fill("input[name=email]", process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com");
  await page.fill("input[name=password]", process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await page.click("button[type=submit]");
  await page.waitForURL(`${BASE}/**`);
}
await page.waitForTimeout(1500); // opening beat: the real Maple dashboard

// Open the Vendo overlay via the branded launcher pill (fall back to the
// ⌘K power path when the pill hasn't mounted yet), then type the off-script
// prompt into the thread composer.
const launcher = page.getByRole("button", { name: /Ask Maple/ });
try {
  await launcher.click({ timeout: 20_000 });
} catch {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
}
const composer = page.locator('textarea[placeholder="Ask anything"]');
await composer.waitFor({ timeout: 15_000 });
await composer.fill(PROMPT);
const typedAt = Date.now();
await composer.press("Enter");

// Screenshot cadence around the ≤5s first-paint criterion, then until done.
const shots = resolve("docs/verification/demo-live-readiness/speed-core");
for (const [name, delay] of [["t+1s", 1000], ["t+2s", 1000], ["t+3s", 1000], ["t+4s", 1000], ["t+5s", 1000], ["t+10s", 5000], ["t+20s", 10000], ["t+40s", 20000]]) {
  await page.waitForTimeout(delay);
  await page.screenshot({ path: join(shots, `maple-${name}.png`) });
  console.log(`${name} at +${Date.now() - typedAt}ms`);
}
await page.waitForTimeout(20_000); // hold to the finished app
await page.screenshot({ path: join(shots, "maple-final.png") });

await context.close();
await browser.close();

const webm = readdirSync(videoDir).find((file) => file.endsWith(".webm"));
if (!webm) throw new Error(`no video in ${videoDir}`);
copyFileSync(join(videoDir, webm), OUT);
console.log(`webm: ${OUT}`);
