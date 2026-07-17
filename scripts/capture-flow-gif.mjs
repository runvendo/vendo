// Capture the director-mode remix flow as a GIF, off the REAL Cadence surface.
// The story: on the dashboard, hover the hero card → click Remix → the Vendo
// overlay opens and builds the micro-app → Slack consent → approve → top-bar
// morph → the finished view lands in place of the original hero card.
// Prereqs: Cadence dev on :3401 (Supabase up) + ffmpeg. Usage: node scripts/capture-flow-gif.mjs [out.gif]
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const requireFromUi = createRequire(resolve("packages/ui/package.json"));
const { chromium } = requireFromUi("@playwright/test");
const run = promisify(execFile);

const BASE = process.env.CADENCE_URL ?? "http://localhost:3401";
const OUT = resolve(process.argv[2] ?? "flow-demo.gif");

const videoDir = mkdtempSync(join(tmpdir(), "vendo-flow-"));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

await page.goto(`${BASE}/login`);
if (page.url().includes("/login")) {
  await page.fill("input[name=email]", "daniel@cadence.test");
  await page.fill("input[name=password]", process.env.CADENCE_DEMO_PASSWORD ?? "cadence-demo");
  await page.click("button[type=submit]");
  await page.waitForURL(`${BASE}/**`);
}

// Dashboard, director mode on.
await page.goto(`${BASE}/?vendodirector=1`);
const hero = page.locator(".group\\/hero").first();
await hero.waitFor({ timeout: 20_000 });
await page.waitForTimeout(1400); // opening beat: the real dashboard

// Hover the hero to reveal Remix, then click it → overlay opens + builds.
await hero.hover();
await page.waitForTimeout(700);
await page.getByRole("button", { name: "Remix this card with Vendo" }).click();

// The overlay builds the micro-app, then parks on the Slack consent card.
const approve = page.getByRole("button", { name: "Approve", exact: true });
await approve.waitFor({ timeout: 30_000 });
await page.waitForTimeout(1600);
await approve.click(); // → top-bar morph + resume

// Closing line, then PIN the app — nothing is saved until this click.
await page.getByText("hears the moment anything comes in", { exact: false }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(2600);
await page.getByRole("button", { name: "Pin to dashboard" }).click();
await page.waitForTimeout(900);
await page.getByRole("button", { name: "Close Vendo" }).click();
await page.waitForTimeout(4200); // hold on the dashboard: the pinned app is now the hero

await context.close();
await browser.close();

const webm = readdirSync(videoDir).find(file => file.endsWith(".webm"));
if (!webm) throw new Error(`no video in ${videoDir}`);
const source = join(videoDir, webm);
const palette = join(videoDir, "palette.png");
await run("ffmpeg", ["-y", "-i", source, "-vf", "fps=12,scale=1000:-1:flags=lanczos,palettegen", palette]);
await run("ffmpeg", [
  "-y", "-i", source, "-i", palette,
  "-filter_complex", "fps=12,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse",
  OUT,
]);
copyFileSync(source, OUT.replace(/\.gif$/, ".webm"));
console.log(`gif: ${OUT}`);
console.log(`webm: ${OUT.replace(/\.gif$/, ".webm")}`);
