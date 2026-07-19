// docs-site UI-section media: hero screenshots + signature motion loops.
//
// Sources:
//   - the built `vendo playground` bundle (packages/vendo/dist) for the real
//     product surfaces incl. the theme editor — `?embed=1#<scenario>` renders
//     one surface alone on the light porcelain page;
//   - the packages/ui e2e vite harness for the two surfaces the playground
//     does not script (command palette, voice stage).
//
// Same capture path as scripts/capture-gallery.mjs (Playwright recordVideo →
// ffmpeg), but loops encode to MP4 (h264, <1.5MB) and heroes are PNG
// screenshots squeezed through pngquant to stay under 300KB.
//
// Prereqs: `pnpm build` (playground serves dist), ffmpeg + pngquant on PATH.
// Usage:
//   node scripts/capture-docs-media.mjs             # capture everything
//   node scripts/capture-docs-media.mjs approval-toast theme-editor  # subset
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const requireFromUi = createRequire(join(packageRoot, "package.json"));
const { chromium } = requireFromUi("@playwright/test");
const { startPlaygroundServer } = await import(
  resolve(packageRoot, "../vendo/dist/cli/playground.js")
);

const OUT_DIR = resolve(packageRoot, "../../docs-site/images/ui");
const VIEWPORT = { width: 1200, height: 760 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** The harness auto-open can race first mount in dev, and clicking "Start
 *  voice" twice toggles the session back off — drive by state instead: nudge
 *  the start button until the session reports running (Stop visible). */
async function startVoice(page) {
  await page.locator('[aria-label="Voice session"]').waitFor();
  const stop = page.getByRole("button", { name: "Stop" });
  for (let i = 0; i < 20 && !(await stop.isVisible().catch(() => false)); i += 1) {
    const start = page.getByRole("button", { name: "Start voice" });
    if (await start.isVisible().catch(() => false)) await start.click().catch(() => {});
    await wait(500);
  }
}

/** Clip a thread pane to its live content: from the first transcript row to
 *  the composer's bottom edge, full pane width — drops the empty headroom a
 *  fixed-height pane carries and the page background below it. */
async function threadContentClip(page, viewport, headroom = 28) {
  const pane = await page.locator(".pg-embed > *").first().boundingBox();
  const composer = await page.locator("form.fl-composer").first().boundingBox();
  const rows = await page.locator(".fl-msglist > *").all();
  let top = pane.y + pane.height;
  for (const row of rows) {
    const box = await row.boundingBox();
    if (box && box.height > 0) top = Math.min(top, box.y);
  }
  const y = Math.max(pane.y, Math.min(top, composer.y) - headroom);
  const bottom = Math.min(viewport.height, composer.y + composer.height + 14);
  return { x: pane.x, y, width: pane.width, height: bottom - y };
}

/** Heroes: one still per chrome surface. `source` picks the server. */
const HEROES = {
  "hero-launcher": {
    source: "playground",
    path: "/?embed=1#overlay-launcher",
    height: 420,
    async ready(page) {
      await page.locator('button[aria-controls="vendo-overlay-dialog"]').waitFor();
      await wait(600);
    },
  },
  "hero-palette": {
    source: "harness",
    path: "/palette",
    css: "main.harness-shell { visibility: hidden; }",
    async ready(page) {
      // One-surface ⌘K: the palette keybinding opens the conversation overlay.
      // The auto-open microtask can race first mount in dev — click the
      // harness's explicit opener instead.
      await page.locator('main[data-scenario="palette"]').waitFor();
      const dialog = page.getByRole("dialog", { name: "Vendo assistant" });
      if (!(await dialog.isVisible().catch(() => false))) {
        await page.getByTestId("palette-opener").click();
      }
      await dialog.waitFor();
      await wait(700);
    },
  },
  "hero-thread-streaming": {
    source: "playground",
    path: "/?embed=1#thread-streaming",
    height: 640,
    clipper: threadContentClip,
    async ready(page) {
      // Mid-stream: a few sentences in, stop affordance visible.
      await page.locator(".fl-msglist").waitFor();
      await wait(6500);
    },
  },
  "hero-approval": {
    source: "playground",
    path: "/?embed=1#approval-flow",
    clipper: threadContentClip,
    async ready(page) {
      await page.locator('article[aria-label^="Approval"]').waitFor({ timeout: 15_000 });
      await wait(700);
    },
  },
  "hero-activities": {
    source: "playground",
    path: "/?embed=1#activities",
    element: ".pg-embed > *",
    async ready() {
      await wait(1500);
    },
  },
  "hero-generated-view": {
    source: "playground",
    path: "/?embed=1#thread-view",
    clipper: threadContentClip,
    async ready(page) {
      await page.getByText("Renewals radar is live").waitFor({ timeout: 20_000 });
      await wait(800);
    },
  },
  "hero-voice-stage": {
    source: "harness",
    path: "/stage",
    element: '[aria-label="Voice session"]',
    async ready(page) {
      await startVoice(page);
      await page.getByRole("button", { name: "Approve" }).waitFor({ timeout: 15_000 });
      await wait(800);
    },
  },
  "hero-theme-editor": {
    source: "playground",
    path: "/#activities",
    async ready(page) {
      await page.getByRole("button", { name: "Open theme editor" }).click();
      await page.getByRole("dialog", { name: "Theme editor" }).waitFor();
      await wait(700);
    },
  },
  "hero-page": {
    source: "playground",
    path: "/?embed=1#page",
    async ready(page) {
      await page.locator('[role="tab"]').first().waitFor();
      await wait(1200);
    },
  },
  "hero-slot-filled": {
    source: "playground",
    path: "/?embed=1#slot-filled",
    height: 620,
    async clipper(page, viewport) {
      const root = await page.locator(".pg-embed > *").first().boundingBox();
      let bottom = root.y;
      for (const child of await page.locator(".pg-embed > * > *").all()) {
        const box = await child.boundingBox();
        if (box && box.height > 0) bottom = Math.max(bottom, box.y + box.height);
      }
      const pad = 14;
      const y = Math.max(0, root.y - pad);
      const end = Math.min(viewport.height, Math.min(root.y + root.height, bottom + pad));
      return { x: root.x, y, width: root.width, height: end - y };
    },
    async ready(page) {
      await wait(1800);
    },
  },
};

/** Loops: 2-4s signature motion, recorded then trimmed/retimed in ffmpeg.
 *  `trim` = seconds cut from the head; `speed` >1 compresses time. */
const LOOPS = {
  "loop-view-arrival": {
    source: "playground",
    path: "/?embed=1#thread-view",
    trim: 2.8,
    speed: 2,
    cropSelector: ".pg-embed > *",
    async play(page) {
      // autoSend fires the build turn; hold through skeleton → finished view.
      await page.getByText("Renewals radar is live").waitFor({ timeout: 25_000 });
      await wait(1200);
    },
  },
  "loop-approval-toast": {
    source: "playground",
    path: "/?embed=1#approval-flow",
    trim: 3.4,
    speed: 1.6,
    cropSelector: ".pg-embed > *",
    async play(page) {
      await page.locator('article[aria-label^="Approval"]').waitFor({ timeout: 15_000 });
      await wait(900);
      await page.getByRole("button", { name: "Approve" }).click();
      await wait(4200);
    },
  },
  "loop-overlay-grow": {
    source: "playground",
    path: "/?embed=1#overlay-launcher",
    trim: 0.8,
    speed: 1.6,
    async play(page) {
      await page.locator('button[aria-controls="vendo-overlay-dialog"]').click();
      await wait(700);
      const box = page.locator("form.fl-composer textarea");
      await box.waitFor();
      await box.fill("Which renewals are at risk?");
      await box.press("Enter");
      await wait(5200);
    },
  },
  "loop-voice-stage": {
    source: "harness",
    path: "/stage",
    trim: 0.6,
    speed: 1.3,
    cropSelector: '[aria-label="Voice session"]',
    cropPad: 12,
    async play(page) {
      await startVoice(page);
      await page.getByRole("button", { name: "Approve" }).waitFor({ timeout: 15_000 });
      await wait(2500);
    },
  },
  "loop-theme-retheme": {
    source: "playground",
    path: "/#activities",
    trim: 1.2,
    speed: 1,
    async play(page) {
      await page.getByRole("button", { name: "Open theme editor" }).click();
      await page.getByRole("dialog", { name: "Theme editor" }).waitFor();
      await wait(600);
      for (const preset of ["Ultramarine", "Dark violet", "Playful round", "Default black"]) {
        await page.getByRole("button", { name: preset }).click();
        await wait(900);
      }
      await wait(400);
    },
  },
};

async function encodeMp4(videoDir, out, { trim = 0, speed = 1 }, cropBox) {
  const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error(`no video in ${videoDir}`);
  const even = (n) => 2 * Math.floor(n / 2);
  const crop = cropBox
    ? `crop=${even(cropBox.width)}:${even(cropBox.height)}:${even(cropBox.x)}:${even(cropBox.y)},`
    : "";
  await run("ffmpeg", ["-y", "-ss", String(trim), "-i", join(videoDir, webm),
    "-vf", `${crop}setpts=PTS/${speed},fps=30,scale=1200:-2:flags=lanczos`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", out]);
}

async function captureHero(browser, base, name, shot) {
  const viewport = { width: VIEWPORT.width, height: shot.height ?? VIEWPORT.height };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    reducedMotion: "no-preference",
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  await page.goto(`${base[shot.source]}${shot.path}`);
  await shot.ready(page);
  // Post-ready cosmetic CSS (e.g. hiding harness scaffolding behind a dialog).
  if (shot.css) {
    await page.addStyleTag({ content: shot.css });
    await wait(150);
  }
  const out = join(OUT_DIR, `${name}.png`);
  // `element` bounds the shot to the surface (plus margin, so soft shadows
  // survive) instead of the full page — kills dead page area around panes.
  let clip;
  if (shot.clipper) {
    clip = await shot.clipper(page, viewport);
  } else if (shot.element) {
    const box = await page.locator(shot.element).first().boundingBox();
    const margin = 16;
    const x = Math.max(0, box.x - margin);
    const y = Math.max(0, box.y - margin);
    clip = {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + margin * 2),
      height: Math.min(viewport.height - y, box.height + margin * 2),
    };
  }
  await page.screenshot({ path: out, animations: "disabled", clip });
  await context.close();
  await run("pngquant", ["--force", "--skip-if-larger", "--quality", "60-90", "--output", out, out]).catch(() => {});
  console.log(`captured ${name}.png (${Math.round(statSync(out).size / 1024)}KB)`);
}

async function captureLoop(browser, base, name, beat) {
  const videoDir = mkdtempSync(join(tmpdir(), `vendo-docs-${name}-`));
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: videoDir, size: VIEWPORT },
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  await page.goto(`${base[beat.source]}${beat.path}`);
  await beat.play(page);
  let cropBox;
  if (beat.cropSelector) {
    const box = await page.locator(beat.cropSelector).first().boundingBox();
    const pad = beat.cropPad ?? 0;
    if (box) {
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      cropBox = {
        x,
        y,
        width: Math.min(VIEWPORT.width - x, box.width + pad * 2),
        height: Math.min(VIEWPORT.height - y, box.height + pad * 2),
      };
    }
  }
  await context.close();
  const out = join(OUT_DIR, `${name}.mp4`);
  await encodeMp4(videoDir, out, beat, cropBox);
  rmSync(videoDir, { recursive: true, force: true });
  console.log(`captured ${name}.mp4 (${Math.round(statSync(out).size / 1024)}KB)`);
}

async function main() {
  const only = process.argv.slice(2);
  mkdirSync(OUT_DIR, { recursive: true });

  const playground = await startPlaygroundServer({ port: 0 });
  const harnessPort = await freePort();
  const vite = spawn("pnpm", ["exec", "vite", "--config", "e2e/harness/vite.config.ts",
    "--host", "127.0.0.1", "--port", String(harnessPort)],
    { cwd: packageRoot, env: { ...process.env, NO_COLOR: "1", VENDO_HARNESS_PORT: String(harnessPort) }, stdio: "ignore" });
  const base = { playground: playground.url, harness: `http://127.0.0.1:${harnessPort}` };
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${base.harness}/thread`); if (r.ok) break; } catch {}
    await wait(500);
  }

  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    for (const [name, shot] of Object.entries(HEROES)) {
      if (only.length && !only.includes(name)) continue;
      await captureHero(browser, base, name, shot);
    }
    for (const [name, beat] of Object.entries(LOOPS)) {
      if (only.length && !only.includes(name)) continue;
      await captureLoop(browser, base, name, beat);
    }
  } finally {
    await browser.close();
    vite.kill("SIGTERM");
    await playground.close();
  }
}

await main();
