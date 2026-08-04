/**
 * capture-evidence — Playwright video → GIF, the one path every UI lane uses
 * for its `docs/superpowers/evidence/**` proof.
 *
 * Prereq: ffmpeg on PATH (`brew install ffmpeg`).
 *
 * CLI (convert a video a Playwright run already produced):
 *   node scripts/capture-evidence.mjs <video.webm|dir> <out.gif> [--fps 12] [--width 900]
 *   # a directory picks its NEWEST *.webm — point it at playwright's outputDir:
 *   node scripts/capture-evidence.mjs packages/ui/e2e/test-results out.gif
 *
 * Module (record a flow and encode it in one call):
 *   import { record, videoToGif } from "../scripts/capture-evidence.mjs";
 *   await record({
 *     url: "http://127.0.0.1:4276/thread",
 *     out: "docs/superpowers/evidence/2026-08-03-ui-redesign/lane-x/turn.gif",
 *     viewport: { width: 1200, height: 720 },
 *     async play(page) { await page.getByRole("button", { name: "Send" }).click(); },
 *   });
 *
 * `record` also keeps the raw .webm beside the .gif — GitHub renders the gif in
 * a PR body, and the webm stays available when a reviewer wants real frames.
 */
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The newest `*.webm` under a directory tree (Playwright nests one per test). */
function newestVideo(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".webm")) found.push({ path, at: statSync(path).mtimeMs });
    }
  };
  walk(root);
  if (found.length === 0) throw new Error(`no .webm under ${root}`);
  found.sort((a, b) => b.at - a.at);
  return found[0].path;
}

/** Two-pass palette encode — the only encode that keeps chrome hairlines from
    dithering into mush at GIF's 256 colours. */
export async function videoToGif(source, out, { fps = 12, width = 900 } = {}) {
  const input = statSync(source).isDirectory() ? newestVideo(source) : source;
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const palette = join(mkdtempSync(join(tmpdir(), "vendo-evidence-")), "palette.png");
  const scale = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  await run("ffmpeg", ["-y", "-i", input, "-vf", `${scale},palettegen`, palette]);
  await run("ffmpeg", ["-y", "-i", input, "-i", palette,
    "-filter_complex", `${scale}[x];[x][1:v]paletteuse`, resolve(out)]);
  rmSync(dirname(palette), { recursive: true, force: true });
  return { gif: resolve(out), source: input };
}

/**
 * Record one flow against an ALREADY-RUNNING surface and encode it.
 * `play(page)` drives the interaction; the clip is cut when it resolves.
 */
export async function record({
  url,
  out,
  play,
  viewport = { width: 1_200, height: 720 },
  deviceScaleFactor = 2,
  fps = 12,
  width = 900,
  keepWebm = true,
  contextOptions = {},
}) {
  const requireFromUi = createRequire(join(repoRoot, "packages/ui/package.json"));
  const { chromium } = requireFromUi("@playwright/test");
  const videoDir = mkdtempSync(join(tmpdir(), "vendo-evidence-"));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor,
      recordVideo: { dir: videoDir, size: viewport },
      ...contextOptions,
    });
    const page = await context.newPage();
    await page.goto(url);
    await play(page);
    await context.close();
    const result = await videoToGif(videoDir, out, { fps, width });
    if (keepWebm) copyFileSync(result.source, resolve(out).replace(/\.gif$/, ".webm"));
    return result;
  } finally {
    await browser.close();
    rmSync(videoDir, { recursive: true, force: true });
  }
}

// CLI: convert only. Recording needs a flow, which is the caller's to write.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, out, ...rest] = process.argv.slice(2);
  if (!source || !out) {
    console.error("usage: node scripts/capture-evidence.mjs <video.webm|dir> <out.gif> [--fps N] [--width N]");
    process.exit(2);
  }
  const flag = (name, fallback) => {
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? fallback : Number(rest[at + 1]);
  };
  const { gif, source: used } = await videoToGif(source, out, {
    fps: flag("fps", 12),
    width: flag("width", 900),
  });
  console.log(`gif: ${gif}\nfrom: ${used}`);
}
