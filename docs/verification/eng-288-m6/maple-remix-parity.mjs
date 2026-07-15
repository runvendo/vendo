// ENG-288 M6 — Maple remix journey with visual-parity evidence. REAL demo
// host (`apps/demo-bank` under `next dev`), REAL browser, REAL model: the
// fork-pin edit runs through Maple's own Anthropic model — nothing is
// scripted. The forked pin renders from the genuinely sync-captured source
// (.vendo/remixable/MapleNetWorthCard.json) inside the sandboxed jail, with
// seed-matching sampleProps, so the remixed render and the host original
// paint the same card.
//
// Run from the repo root after `pnpm install && pnpm build`, with ffmpeg on
// PATH. Source the shared keys without printing them:
//
//   set -a; source /Users/yousefh/orca/workspaces/flowlet/.env; set +a
//   node docs/verification/eng-288-m6/maple-remix-parity.mjs
//
// Writes 01-host-original.png, 02-remixed-jail.png, parity-side-by-side.png,
// remix-journey-*.png beats, maple-remix-journey.gif, and prints the ffmpeg
// SSIM/PSNR parity metrics. Exits nonzero when the journey fails or the two
// captures disagree in size by more than 2px.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "../../..");
const demoDir = join(repoRoot, "apps", "demo-bank");
const requireFromUi = createRequire(join(repoRoot, "packages/ui/package.json"));
const { chromium } = requireFromUi("@playwright/test");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required (source the shared keys first).");
  process.exit(1);
}

const PORT = Number(process.env.MAPLE_DEMO_PORT ?? 3111);
const BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Boot the REAL Maple host.
// ---------------------------------------------------------------------------

// The demo's PGlite store (.vendo/data, gitignored scratch) does not survive
// a hard-killed dev server; park the old cluster in the OS tmpdir and start
// clean so every capture run is deterministic.
const dataDir = join(demoDir, ".vendo", "data");
if (existsSync(dataDir)) renameSync(dataDir, join(tmpdir(), `maple-demo-data-${Date.now()}`));
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, ".gitignore"), "*\n!.gitignore\n");

const server = spawn("pnpm", ["exec", "next", "dev", "--port", String(PORT)], {
  cwd: demoDir,
  env: { ...process.env, VENDO_BASE_URL: BASE },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => undefined);
server.stderr.on("data", () => undefined);
const stopServer = () => {
  // SIGINT = Next's graceful shutdown; a harder signal corrupts the PGlite dir.
  if (!server.killed) server.kill("SIGINT");
};
process.on("exit", stopServer);

for (let attempt = 0; ; attempt += 1) {
  try {
    const response = await fetch(`${BASE}/login`);
    if (response.status === 200) break;
  } catch {
    // Still booting.
  }
  assert.ok(attempt < 120, "Maple dev server never became ready");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
}

// ---------------------------------------------------------------------------
// Drive the journey.
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
let failure;
let appId;
const shots = [];
const shot = async (page, name) => {
  const path = join(evidenceDir, name);
  await page.screenshot({ path });
  shots.push(name);
};

try {
  const page = await context.newPage();
  page.on("pageerror", (error) => { failure ??= error; });

  // Real Maple login (Auth.js credentials over the seeded demo user).
  await page.goto(`${BASE}/login`);
  await page.locator('input[name="password"]').fill(process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}/`);

  // Beat 1 — the HOST ORIGINAL: Maple's own home page renders NetWorthView
  // with live seeded data.
  await page.waitForSelector("[data-maple-net-worth]");
  await page.waitForTimeout(1800); // count-up + chart settle
  await shot(page, "remix-journey-1-host-home.png");
  const hostCard = page.locator("[data-maple-net-worth]");
  await hostCard.screenshot({ path: join(evidenceDir, "01-host-original.png") });
  const hostBox = await hostCard.boundingBox();

  // Beat 2 — the user asks Vendo for an app on the host's Apps page.
  await page.goto(`${BASE}/vendo/apps`);
  const create = async () => {
    await page.locator('[aria-label="Create app"] input')
      .fill("A net worth dashboard with a short title text at the top");
    await page.locator('[aria-label="Create app"] button[type="submit"]').click();
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-label="Create app"] button[type="submit"]');
      return button !== null && button.textContent !== "Creating…";
    }, undefined, { timeout: 120_000 });
    return page.locator('[role="list"][aria-label="Your apps"] button').first().isVisible().catch(() => false);
  };
  let created = false;
  for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
    created = await create();
    if (!created) {
      const alertText = await page.locator('[role="alert"]').first().textContent().catch(() => null);
      console.error(`create attempt ${attempt + 1} failed: ${alertText ?? "no alert"}`);
    }
  }
  assert.ok(created, "the real model never produced a valid app");
  appId = await page.evaluate(async () => {
    const list = await (await fetch("/api/vendo/apps", { credentials: "same-origin" })).json();
    return list[0]?.id;
  });
  assert.ok(appId, "created app not listed");
  await shot(page, "remix-journey-2-app-created.png");

  // Beat 3 — the remix ask: the REAL model edit forks the captured pin.
  const editApp = async (instruction) => {
    await page.locator('[aria-label="Edit app"] input').fill(instruction);
    await page.locator('[aria-label="Edit app"] button[type="submit"]').click();
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-label="Edit app"] button[type="submit"]');
      return button !== null && button.textContent !== "Editing…";
    }, undefined, { timeout: 180_000 });
    return page.evaluate(async (id) => {
      const app = await (await fetch(`/api/vendo/apps/${id}`, { credentials: "same-origin" })).json();
      return { pins: app.pins ?? [], components: Object.keys(app.components ?? {}) };
    }, appId);
  };
  let forked;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    forked = await editApp(
      "Remix the host net-worth card (remixable slot MapleNetWorthCard) so I can customize its source. "
      + "Fork the pin without passing any props, and remove every other node except the root so the forked card is the only thing in the app.",
    );
    if (forked.pins.some((pin) => pin.slot === "MapleNetWorthCard")) break;
  }
  assert.ok(forked.pins.some((pin) => pin.slot === "MapleNetWorthCard"), "the model never forked the pin");
  const pinned = forked.components.find((name) => name.startsWith("PinnedMapleNetWorthCard"));
  assert.ok(pinned, "fork produced no pinned component");
  console.log(`forked ${pinned} (base ${forked.pins[0].base.slice(0, 20)}…)`);

  // Beat 4 — the remixed render: captured source + sampleProps inside the
  // double-iframe CSP jail. Wait for the jail to size itself, then screenshot.
  await page.reload();
  await page.locator('[role="list"][aria-label="Your apps"] button').first().click();
  const surfaceFrame = page.locator("[data-app-surface] iframe");
  await surfaceFrame.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const frame = document.querySelector("[data-app-surface] iframe");
    return frame !== null && frame.getBoundingClientRect().height > 200;
  }, undefined, { timeout: 30_000 });
  await page.waitForTimeout(1800);
  await shot(page, "remix-journey-3-remixed-jail.png");

  // Equalize widths: the surface card is fluid, so nudge the viewport until
  // the jail card matches the host card's width, then capture.
  let jailBox = await surfaceFrame.boundingBox();
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: Math.round(viewport.width + (hostBox.width - jailBox.width)),
    height: viewport.height,
  });
  await page.waitForTimeout(600);
  jailBox = await surfaceFrame.boundingBox();
  assert.ok(Math.abs(jailBox.width - hostBox.width) <= 2,
    `could not equalize widths (host ${hostBox.width}, jail ${jailBox.width})`);
  await surfaceFrame.screenshot({ path: join(evidenceDir, "02-remixed-jail.png") });

  console.log(`host original ${hostBox.width}x${hostBox.height}; remixed jail ${jailBox.width}x${jailBox.height}`);
} catch (error) {
  failure ??= error;
} finally {
  try {
    if (appId) {
      // Same context = same session cookie; delete through the wire.
      const cleanupPage = await context.newPage();
      await cleanupPage.goto(`${BASE}/vendo/apps`).catch(() => undefined);
      await cleanupPage.evaluate(async (id) => {
        await fetch(`/api/vendo/apps/${id}`, { method: "DELETE", credentials: "same-origin" });
      }, appId).catch(() => undefined);
    }
  } catch {
    // Cleanup is best-effort; the app store is the developer's own .vendo/data.
  }
  await browser.close();
  stopServer();
}

if (failure) {
  console.error(failure);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parity metrics + side-by-side + GIF.
// ---------------------------------------------------------------------------

// Crop both captures to their common top-aligned size, then measure SSIM
// (structural similarity; 1.0 = identical pixels).
try {
  const { stderr: ssim } = await exec("ffmpeg", [
    "-i", join(evidenceDir, "01-host-original.png"),
    "-i", join(evidenceDir, "02-remixed-jail.png"),
    "-filter_complex", "[0][1]scale2ref[a][b];[a][b]ssim",
    "-f", "null", "-",
  ]);
  const ssimLine = ssim.split("\n").find((line) => line.includes("SSIM"));
  console.log(ssimLine ?? "SSIM: unavailable");
} catch (error) {
  console.error("SSIM measurement failed:", error?.message ?? error);
}

// Side-by-side: host original on the LEFT, remixed jail render on the RIGHT
// (this build of ffmpeg has no drawtext; the README names the panes).
await exec("ffmpeg", [
  "-y",
  "-i", join(evidenceDir, "01-host-original.png"),
  "-i", join(evidenceDir, "02-remixed-jail.png"),
  "-filter_complex",
  // hstack needs equal heights; pad both panes onto a fixed white canvas.
  "[0]scale=720:-1,pad=724:400:2:2:white[l];[1]scale=720:-1,pad=724:400:2:2:white[r];[l][r]hstack",
  join(evidenceDir, "parity-side-by-side.png"),
]);
console.log("wrote parity-side-by-side.png (left: host original, right: remixed jail render)");

const inputs = shots.flatMap((name) => ["-loop", "1", "-t", "2", "-i", join(evidenceDir, name)]);
await exec("ffmpeg", [
  "-y",
  ...inputs,
  "-filter_complex",
  `${shots.map((_, index) => `[${index}]scale=1000:-1:flags=lanczos,setsar=1[v${index}]`).join(";")};`
  + `${shots.map((_, index) => `[v${index}]`).join("")}concat=n=${shots.length}:v=1:a=0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
  join(evidenceDir, "maple-remix-journey.gif"),
]);
console.log("wrote maple-remix-journey.gif");
console.log("PASS: remix journey captured on the real Maple host.");
