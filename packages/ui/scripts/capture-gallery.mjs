// ENG-232 — the Block: @vendoai/ui GIF gallery.
//
// Captures the core surface + headline-stress GIFs off the real-browser harness
// (the deterministic wire fixture that STREAMS exactly like the demos — the same
// @vendoai/ui chrome the hosts mount). Each clip is Playwright recordVideo →
// ffmpeg palette GIF, the proven capture path from scripts/capture-flow-gif.mjs.
//
// Prereqs: ffmpeg on PATH. Usage:
//   node scripts/capture-gallery.mjs            # capture all GIF beats
//   node scripts/capture-gallery.mjs voice-consent long-thread   # a subset
//   node scripts/capture-gallery.mjs cards      # one PNG per card case
//
// `cards` is the designed CARD reference (card audit §10): it drives the
// gallery app's `#cards` board — every card kind × state × degraded-data case,
// rendered through the real components — and writes one PNG per
// `[data-gallery-case]` into the lane-G evidence folder. The toolkit logo CDN
// is stubbed so the capture is offline-deterministic, then a second pass
// BLOCKS it and recaptures the logo-bearing cases as `<id>--logo-failed.png`
// (the forced `onError` fallback, proved rather than asserted).
//
// The vite server is launched here on a fixed port and torn down at the end;
// nothing else needs to be running.
import { execFile, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const requireFromUi = createRequire(join(packageRoot, "package.json"));
const { chromium } = requireFromUi("@playwright/test");

const PORT = Number(process.env.VENDO_GALLERY_PORT) || 4271;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(packageRoot, "../../docs/verification/eng-232");
/** Lane G's card reference is the default home; a later lane re-shooting the
 *  same board for its OWN proof points VENDO_CARDS_OUT_DIR at its own folder
 *  rather than rewriting somebody else's evidence. */
const CARDS_OUT_DIR = process.env.VENDO_CARDS_OUT_DIR
  ? resolve(process.env.VENDO_CARDS_OUT_DIR)
  : resolve(packageRoot, "../../docs/superpowers/evidence/2026-08-03-ui-redesign/lane-g/cards");
const VIEWPORT = { width: 1200, height: 720 };
const MOBILE = { width: 390, height: 844 };
const LOGO_CDN = "https://logos.composio.dev/**";
/** A 16×16 solid-blue PNG — stands in for every toolkit mark so the card
    reference never depends on the network, and stays VISIBLY a mark so the
    blocked-logo pass reads as a real difference (a card with no `onError`
    fallback loses the well entirely; ConnectCard's falls back to its glyph). */
const STUB_LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPQzvn2nxLMMGrAqAGjBgwXAwAulYwffXWsWgAAAABJRU5ErkJggg==",
  "base64",
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each beat: navigate a harness scenario, run an interaction, hold the frames.
 *  `page` is a fresh recorded page; the returned promise resolves when the beat
 *  is done and the video should be cut. */
const BEATS = {
  "thread-streaming": {
    scenario: "composer",
    viewport: VIEWPORT,
    async play(page) {
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("[stream-long] walk me through this month's spending in detail");
      await box.press("Enter");
      await wait(8500); // the paced long stream + settle
    },
  },
  "long-thread-jump": {
    scenario: "thread-extreme",
    viewport: VIEWPORT,
    async play(page) {
      const list = page.locator(".fl-msglist");
      await list.waitFor();
      await wait(800);
      await list.evaluate((node) => node.scrollTo({ top: 0, behavior: "smooth" }));
      await wait(1600);
      const jump = page.getByRole("button", { name: "Jump to latest" });
      if (await jump.count()) { await jump.click(); await wait(1400); }
    },
  },
  "mid-stream-kill": {
    scenario: "composer",
    viewport: VIEWPORT,
    async play(page) {
      const box = page.getByRole("textbox", { name: "Message" });
      await box.fill("[stream-kill] draft the welcome email");
      await box.press("Enter");
      await page.locator(".fl-error").waitFor({ timeout: 15_000 });
      await wait(2200); // hold on the error banner + Retry
    },
  },
  "humanized-approval": {
    scenario: "thread-humanized",
    viewport: VIEWPORT,
    async play(page) {
      await page.getByText(/Transfer funds/i).first().waitFor({ timeout: 15_000 }).catch(() => {});
      await wait(2400); // hold on the humanized beats + friendly approval card
    },
  },
  "affordances-connect": {
    scenario: "affordances",
    viewport: VIEWPORT,
    async play(page) {
      await page.getByRole("button", { name: "Copy code" }).waitFor({ timeout: 10_000 }).catch(() => {});
      await page.locator(".fl-codeblock").hover().catch(() => {});
      await wait(900);
      await page.getByRole("button", { name: "Connect tools" }).click();
      await wait(1800);
    },
  },
  "slot-pinned": {
    scenario: "slot-pinned",
    viewport: VIEWPORT,
    async play() { await wait(2200); },
  },
  "palette": {
    scenario: "palette",
    viewport: VIEWPORT,
    async play(page) {
      await page.getByRole("dialog", { name: "Vendo command palette" }).waitFor({ timeout: 8000 }).catch(() => {});
      await wait(1400);
    },
  },
  "mobile-takeover": {
    scenario: "overlay",
    viewport: MOBILE,
    async play(page) {
      await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor({ timeout: 8000 }).catch(() => {});
      await wait(1800);
    },
  },
  "dark-brand": {
    scenario: "page-chat-dark",
    viewport: VIEWPORT,
    async play() { await wait(2000); },
  },
  "voice-consent": {
    scenario: "stage-full",
    viewport: VIEWPORT,
    async play(page) {
      await page.locator(".fl-voice-consent").waitFor({ timeout: 12_000 }).catch(() => {});
      await wait(2600); // hold on the feed + consent bar
    },
  },
  "voice-drawer": {
    scenario: "stage-drawer",
    viewport: VIEWPORT,
    async play(page) {
      await wait(1200);
      await page.getByRole("button", { name: "Transcript" }).click().catch(() => {});
      await wait(1800);
    },
  },
  "activity": {
    scenario: "activity",
    viewport: VIEWPORT,
    async play() { await wait(1800); },
  },
};

async function encode(videoDir, out) {
  const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error(`no video in ${videoDir}`);
  const source = join(videoDir, webm);
  const palette = join(videoDir, "palette.png");
  await run("ffmpeg", ["-y", "-i", source, "-vf", "fps=12,scale=900:-1:flags=lanczos,palettegen", palette]);
  await run("ffmpeg", ["-y", "-i", source, "-i", palette,
    "-filter_complex", "fps=12,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse", out]);
}

async function captureBeat(browser, name, beat) {
  const videoDir = mkdtempSync(join(tmpdir(), `vendo-gif-${name}-`));
  const context = await browser.newContext({
    viewport: beat.viewport,
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: beat.viewport },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/${beat.scenario}`);
  await wait(700); // opening beat
  await beat.play(page);
  await context.close();
  const out = join(OUT_DIR, `${name}.gif`);
  await encode(videoDir, out);
  rmSync(videoDir, { recursive: true, force: true });
  console.log(`captured ${name}.gif`);
}

/** Serve one vite app on PORT until `body` resolves. */
async function withServer(viteConfig, probePath, body) {
  const vite = spawn("pnpm", ["exec", "vite", "--config", viteConfig,
    "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: packageRoot, env: { ...process.env, NO_COLOR: "1", VENDO_HARNESS_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}${probePath}`); if (r.ok) break; } catch {}
    await wait(500);
  }
  const browser = await chromium.launch();
  try {
    await body(browser);
  } finally {
    await browser.close();
    vite.kill("SIGTERM");
  }
}

/** One PNG per card case, with the logo CDN stubbed; then the blocked-logo pass. */
async function captureCards(browser) {
  mkdirSync(CARDS_OUT_DIR, { recursive: true });
  let written = 0;
  for (const logos of ["stubbed", "blocked"]) {
    const context = await browser.newContext({ viewport: { width: 900, height: 1_200 }, deviceScaleFactor: 2 });
    await context.route(LOGO_CDN, route => logos === "blocked"
      ? route.abort()
      : route.fulfill({ status: 200, contentType: "image/png", body: STUB_LOGO }));
    const page = await context.newPage();
    await page.goto(`${BASE}/#cards`);
    // The blocked pass only re-shoots the cards that carry a remote mark.
    const cases = page.locator(logos === "blocked" ? "[data-gallery-case][data-gallery-logo]" : "[data-gallery-case]");
    await cases.first().waitFor({ timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await wait(900); // entrance transitions settle before the shutter
    for (const item of await cases.all()) {
      const id = await item.getAttribute("data-gallery-case");
      const suffix = logos === "blocked" ? "--logo-failed" : "";
      await item.scrollIntoViewIfNeeded();
      await item.screenshot({ path: join(CARDS_OUT_DIR, `${id}${suffix}.png`) });
      written += 1;
    }
    await context.close();
  }
  console.log(`captured ${written} card PNGs → ${CARDS_OUT_DIR}`);
}

async function main() {
  const only = process.argv.slice(2);
  if (only[0] === "cards") {
    await withServer("gallery/vite.config.ts", "/", captureCards);
    return;
  }
  const names = only.length ? only : Object.keys(BEATS);
  mkdirSync(OUT_DIR, { recursive: true });
  await withServer("e2e/harness/vite.config.ts", "/thread", async (browser) => {
    for (const name of names) {
      const beat = BEATS[name];
      if (!beat) { console.warn(`unknown beat: ${name}`); continue; }
      await captureBeat(browser, name, beat);
    }
  });
}

await main();
