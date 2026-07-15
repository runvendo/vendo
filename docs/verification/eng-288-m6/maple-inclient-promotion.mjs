// ENG-288 M6 — in-client promotion end-to-end on the REAL Maple host, in a
// real browser, with Maple's REAL model doing every edit:
//
//   fork a captured host pin → customize it (a live "Probe host fetch" button
//   proves which authority the code runs under) → ship-diff shows the exact
//   reviewable delta → approval injected through the documented dev seam
//   (docs/in-client-approvals.md) → the hash-pinned version mounts natively in
//   the host page ([data-vendo-inclient-mount], ZERO iframes, probe fetch
//   SUCCEEDS) → one more edit changes the version hash → the surface drops
//   back to the CSP jail with the loud invalidation notice (probe fetch FAILS
//   again).
//
// Run from the repo root after `pnpm install && pnpm build`, with ffmpeg on
// PATH. Source the shared keys without printing them:
//
//   set -a; source /Users/yousefh/orca/workspaces/flowlet/.env; set +a
//   node docs/verification/eng-288-m6/maple-inclient-promotion.mjs
//
// Writes promotion-*.png beats and maple-inclient-promotion.gif; exits
// nonzero when any enforcement step misbehaves.

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

const PORT = Number(process.env.MAPLE_DEMO_PORT ?? 3112);
const BASE = `http://localhost:${PORT}`;

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
    if ((await fetch(`${BASE}/login`)).status === 200) break;
  } catch {
    // Still booting.
  }
  assert.ok(attempt < 120, "Maple dev server never became ready");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
let failure;
let appId;
const shots = [];
const shot = async (page, name) => {
  await page.screenshot({ path: join(evidenceDir, name) });
  shots.push(name);
};

try {
  const page = await context.newPage();
  page.on("pageerror", (error) => { failure ??= error; });

  await page.goto(`${BASE}/login`);
  await page.locator('input[name="password"]').fill(process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}/`);
  await page.goto(`${BASE}/vendo/apps`);

  // -------------------------------------------------------------------------
  // Create + fork + customize, all through the real model edit path.
  // -------------------------------------------------------------------------
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
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) created = await create();
  assert.ok(created, "the real model never produced a valid app");
  appId = await page.evaluate(async () => {
    const list = await (await fetch("/api/vendo/apps", { credentials: "same-origin" })).json();
    return list[0]?.id;
  });
  assert.ok(appId, "created app not listed");

  const editApp = async (instruction) => {
    await page.locator('[aria-label="Edit app"] input').fill(instruction);
    await page.locator('[aria-label="Edit app"] button[type="submit"]').click();
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-label="Edit app"] button[type="submit"]');
      return button !== null && button.textContent !== "Editing…";
    }, undefined, { timeout: 180_000 });
    return page.evaluate(async (id) => {
      const app = await (await fetch(`/api/vendo/apps/${id}`, { credentials: "same-origin" })).json();
      return { pins: app.pins ?? [], components: app.components ?? {} };
    }, appId);
  };

  let state;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    state = await editApp(
      "Remix the host net-worth card (remixable slot MapleNetWorthCard) so I can customize its source. "
      + "Fork the pin without passing any props, and remove every other node except the root so the forked card is the only thing in the app.",
    );
    if (state.pins.some((pin) => pin.slot === "MapleNetWorthCard")) break;
  }
  assert.ok(state.pins.some((pin) => pin.slot === "MapleNetWorthCard"), "the model never forked the pin");
  const pinned = Object.keys(state.components).find((name) => name.startsWith("PinnedMapleNetWorthCard"));
  assert.ok(pinned, "fork produced no pinned component");

  const hasProbe = () => typeof state.components.FetchProbe === "string"
    && state.components.FetchProbe.includes("Probe host fetch");
  // Careful phrasing: the edit router treats words like "api"/"server" as a
  // machine-code request; this probe is a plain client-side tree component.
  for (let attempt = 0; attempt < 3 && !hasProbe(); attempt += 1) {
    state = await editApp(
      "Add a new small generated component named FetchProbe below the forked card, keeping the forked card untouched. "
      + "FetchProbe renders one button labeled \"Probe host fetch\". When clicked it tries fetch('/login', { credentials: 'same-origin' }) "
      + "in a try/catch and swaps its own label to 'fetch: SUCCESS (host authority)' when response.ok is true, "
      + "or to 'fetch: FAILURE (CSP)' when the call throws or response.ok is false.",
    );
  }
  assert.ok(hasProbe(), "the model never added the probe component");

  const openSurface = async () => {
    await page.reload();
    await page.locator('[role="list"][aria-label="Your apps"] button').first().click();
    await page.waitForFunction(() => {
      const surface = document.querySelector("[data-app-surface]");
      if (surface === null) return false;
      const mount = surface.querySelector("[data-vendo-inclient-mount]");
      const frame = surface.querySelector("iframe");
      return mount !== null || (frame !== null && frame.getBoundingClientRect().height > 200);
    }, undefined, { timeout: 60_000 });
    await page.waitForTimeout(1800);
  };

  const surfaceState = () => page.evaluate(() => {
    const surface = document.querySelector("[data-app-surface]");
    return {
      mounted: [...(surface?.querySelectorAll("[data-vendo-inclient-mount]") ?? [])]
        .map((element) => element.getAttribute("data-vendo-inclient-mount")),
      iframes: surface?.querySelectorAll("iframe").length ?? -1,
    };
  });

  const probeFrom = async (root) => {
    await root.getByRole("button", { name: "Probe host fetch" }).click();
    await root.getByText(/fetch: (SUCCESS|FAILURE)/).waitFor({ timeout: 15_000 });
    return (await root.getByText(/fetch: (SUCCESS|FAILURE)/).textContent()).trim();
  };

  // -------------------------------------------------------------------------
  // Beat 1 — before approval: the jail. The probe fetch FAILS under the CSP.
  // -------------------------------------------------------------------------
  await openSurface();
  let venue = await surfaceState();
  assert.equal(venue.mounted.length, 0, "no approval exists yet, so nothing may mount in-client");
  assert.ok(venue.iframes >= 2, "the jail iframes must carry the fork and the probe before approval");
  const jail = page
    .frameLocator('iframe[title="Generated component: FetchProbe"]')
    .frameLocator("iframe");
  const jailProbe = await probeFrom(jail);
  assert.match(jailProbe, /FAILURE/, `the jail CSP must block the probe fetch (got: ${jailProbe})`);
  await shot(page, "promotion-1-jail-fetch-blocked.png");
  console.log(`beat 1: jail, probe → ${jailProbe}`);

  // -------------------------------------------------------------------------
  // Beat 2 — the ship-diff: the exact reviewable delta an approval would pin.
  // -------------------------------------------------------------------------
  await page.locator("text=Load ship-diff").click();
  await page.locator("[data-ship-diff]").waitFor({ timeout: 15_000 });
  const diffText = await page.locator("[data-ship-diff]").innerText();
  assert.ok(diffText.includes("MapleNetWorthCard"), "ship-diff must show the forked slot");
  assert.ok(diffText.includes("FetchProbe"), "ship-diff must show the net-new generated component");
  await page.locator("[data-ship-diff]").scrollIntoViewIfNeeded();
  await shot(page, "promotion-2-ship-diff.png");
  console.log("beat 2: ship-diff shows the forked slot and the probe-button delta");

  // -------------------------------------------------------------------------
  // Beat 3 — inject the approval through the documented dev seam and reopen:
  // the hash-pinned version mounts natively in the host page.
  // -------------------------------------------------------------------------
  const approval = await page.evaluate(async (id) => {
    const response = await fetch("/api/vendo/dev/inclient-approval", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: id, approvedBy: "local-review" }),
    });
    return { status: response.status, body: await response.json() };
  }, appId);
  assert.equal(approval.status, 200, "the dev approval seam must accept the owner session");
  console.log(`beat 3: approval pinned ${approval.body.versionHash.slice(0, 24)}… by ${approval.body.approvedBy}`);

  await openSurface();
  venue = await surfaceState();
  assert.ok(venue.mounted.some((name) => name.startsWith("PinnedMapleNetWorthCard")), "the approved fork must mount in-client");
  assert.ok(venue.mounted.includes("FetchProbe"), "the approved probe must mount in-client");
  assert.equal(venue.iframes, 0, "an in-client mount renders in the HOST PAGE, not an iframe");
  const hostProbe = await probeFrom(page.locator('[data-vendo-inclient-mount="FetchProbe"]'));
  assert.match(hostProbe, /SUCCESS/, `the host-page mount must reach the network (got: ${hostProbe})`);
  await shot(page, "promotion-3-inclient-mounted.png");
  console.log(`beat 3: host-page mount active, probe → ${hostProbe}`);

  // -------------------------------------------------------------------------
  // Beat 4 — a new version drops back to the jail, loudly.
  // -------------------------------------------------------------------------
  await editApp("Rename this app to Net worth v2. Change nothing else.");
  await openSurface();
  venue = await surfaceState();
  assert.equal(venue.mounted.length, 0, "a changed version hash must not keep the in-client mount");
  assert.ok(venue.iframes >= 2, "the new version must be back in the jail");
  const notice = page.getByRole("note", { name: "In-client approval invalidated" }).first();
  await notice.waitFor({ timeout: 15_000 });
  assert.match(await notice.innerText(), /re-approved/);
  const droppedProbe = await probeFrom(
    page.frameLocator('iframe[title="Generated component: FetchProbe"]').frameLocator("iframe"),
  );
  assert.match(droppedProbe, /FAILURE/, `after drop-back the CSP must block the probe again (got: ${droppedProbe})`);
  await shot(page, "promotion-4-dropback-notice.png");
  console.log(`beat 4: drop-back with loud notice, probe → ${droppedProbe}`);
} catch (error) {
  failure ??= error;
} finally {
  try {
    if (appId) {
      const cleanupPage = await context.newPage();
      await cleanupPage.goto(`${BASE}/vendo/apps`).catch(() => undefined);
      await cleanupPage.evaluate(async (id) => {
        await fetch(`/api/vendo/apps/${id}`, { method: "DELETE", credentials: "same-origin" });
      }, appId).catch(() => undefined);
    }
  } catch {
    // Best-effort cleanup.
  }
  await browser.close();
  stopServer();
}

if (failure) {
  console.error(failure);
  process.exit(1);
}

const inputs = shots.flatMap((name) => ["-loop", "1", "-t", "2.4", "-i", join(evidenceDir, name)]);
await exec("ffmpeg", [
  "-y",
  ...inputs,
  "-filter_complex",
  `${shots.map((_, index) => `[${index}]scale=1000:-1:flags=lanczos,setsar=1[v${index}]`).join(";")};`
  + `${shots.map((_, index) => `[v${index}]`).join("")}concat=n=${shots.length}:v=1:a=0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
  join(evidenceDir, "maple-inclient-promotion.gif"),
]);
console.log("wrote maple-inclient-promotion.gif");
console.log("PASS: in-client promotion enforced end to end on the real Maple host.");
