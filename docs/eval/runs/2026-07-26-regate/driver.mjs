/**
 * RE-GATE driver (2026-07-26) — healed-mechanisms re-run of the voided 2026-07-25 rematch — dedicated headless Playwright instance
 * (never the shared MCP browser), driving the REAL Apps create path on the
 * production demo hosts. Adapted from the rematch driver (docs/eval/runs/2026-07-25-rematch, PR #577) and
 * (docs/eval/runs/2026-07-21-remix-baseline/driver.mjs).
 *
 * Usage:
 *   node driver.mjs setup <host>
 *   node driver.mjs create <host> <label> <prompt>
 *   node driver.mjs open <host> <appId> <label>
 *   node driver.mjs getjson <host> <path> [label]
 * hosts: maple (http://localhost:3100, /vendo/apps)
 *        cadence (http://localhost:3300, /vendo/workspace apps tab)
 *
 * Evidence per create: <label>.png (full page, post-settle), <label>.aria.yml
 * (accessibility snapshot for value-level judging), timing (Create click →
 * app id on the wire) printed to stdout. Storage states live in the session
 * scratchpad, never the repo.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const pnpmStore = join(root, "node_modules", ".pnpm");
const playwrightEntry = existsSync(pnpmStore)
  ? readdirSync(pnpmStore).find((entry) => /^playwright@/.test(entry))
  : undefined;
const { chromium } = await import(
  playwrightEntry
    ? join(pnpmStore, playwrightEntry, "node_modules/playwright/index.mjs")
    : "playwright"
);

const SCRATCH = process.env.REGATE_SCRATCH ?? join(tmpdir(), "vendo-regate-eval");
const SHOTS = join(here, "shots");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

const HOSTS = {
  maple: { base: "http://localhost:3100", appsPath: "/vendo/apps" },
  cadence: { base: "http://localhost:3300", appsPath: "/vendo/workspace" },
};

const [, , command, host, ...rest] = process.argv;
const cfg = HOSTS[host];
if (!cfg) {
  console.error("unknown host", host);
  process.exit(2);
}
const statePath = join(SCRATCH, `${host}-state.json`);

const errors = [];
async function withPage(fn, { useState = true } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1400 },
    ...(useState && existsSync(statePath) ? { storageState: statePath } : {}),
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    return await fn(page, context);
  } finally {
    await context.close();
    await browser.close();
  }
}

function reportErrors(label) {
  if (errors.length > 0) {
    writeFileSync(join(SHOTS, `${label}-console.log`), errors.join("\n"));
    console.log(`console-errors: ${errors.length} (${label}-console.log)`);
  } else {
    console.log("console-errors: 0");
  }
}

async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(`/api/vendo${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  }, { method, path, body });
}

async function settleSurface(page, ms = 8000) {
  await page.waitForTimeout(ms);
}

async function capture(page, label) {
  await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: true });
  try {
    const aria = await page.locator("body").ariaSnapshot();
    writeFileSync(join(SHOTS, `${label}.aria.yml`), aria);
  } catch (error) {
    console.log(`aria-snapshot failed: ${error}`);
  }
}

// Wait for a busy button label (e.g. /Creating…/) to appear, then clear.
async function waitBusyLabelCleared(page, pattern, timeout = 420_000) {
  await page.waitForFunction((source) => {
    const re = new RegExp(source);
    return [...document.querySelectorAll("button")]
      .some((button) => re.test(button.textContent ?? ""));
  }, pattern.source, { timeout: 5_000 }).catch(() => {});
  await page.waitForFunction((source) => {
    const re = new RegExp(source);
    return ![...document.querySelectorAll("button")]
      .some((button) => re.test(button.textContent ?? ""));
  }, pattern.source, { timeout });
}

// Cadence's VendoPage create button shows no busy state, so completion is
// detected on the wire: the new app id appears in GET /apps once done.
async function waitCreatedApp(page, beforeIds, timeout = 420_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const now = await api(page, "GET", "/apps");
    const created = (now.json ?? []).find((app) => !beforeIds.has(app.id));
    if (created) return created;
  }
  return undefined;
}

async function mapleSelectApp(page, appId) {
  const doc = await api(page, "GET", `/apps/${appId}`);
  if (doc.status !== 200) throw new Error(`app ${appId} not found: ${doc.status}`);
  const list = await api(page, "GET", "/apps");
  const index = (list.json ?? []).findIndex((app) => app.id === appId);
  if (index === -1) throw new Error(`app ${appId} missing from list`);
  await page.getByRole("list", { name: "Your apps" }).getByRole("listitem").nth(index)
    .getByRole("button").first().click();
  await page.waitForSelector("[data-app-surface]");
  return doc.json;
}

async function cadenceOpenApp(page, appId) {
  const doc = await api(page, "GET", `/apps/${appId}`);
  if (doc.status !== 200) throw new Error(`app ${appId} not found: ${doc.status}`);
  const list = await api(page, "GET", "/apps");
  const sameName = (list.json ?? []).filter((app) => app.name === doc.json.name);
  const nameIndex = Math.max(sameName.findIndex((app) => app.id === appId), 0);
  const card = page.locator("article", { hasText: doc.json.name }).nth(nameIndex);
  await card.getByRole("button", { name: "Open" }).click();
  await page.waitForSelector('section[aria-label="Open app"]', { timeout: 60_000 });
  return doc.json;
}

async function gotoApps(page) {
  await page.goto(`${cfg.base}${cfg.appsPath}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  if (host === "cadence") {
    const tab = page.getByRole("tab", { name: /apps/i });
    if (await tab.count()) await tab.click();
    else await page.getByRole("button", { name: /^apps$/i }).first().click();
    await page.waitForTimeout(500);
  }
}

function mintCadenceJwt() {
  const secret = process.env.SUPABASE_JWT_SECRET
    ?? "super-secret-jwt-token-with-at-least-32-characters-long";
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    aud: "authenticated",
    role: "authenticated",
    sub: "8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01",
    email: "maya@cadence.test",
    user_metadata: { name: "Maya Alvarez" },
    iat: now,
    exp: now + 60 * 60 * 24,
  });
  const signature = createHmac("sha256", secret).update(`${head}.${payload}`).digest("base64url");
  return `${head}.${payload}.${signature}`;
}

if (command === "setup") {
  await withPage(async (page, context) => {
    if (host === "maple") {
      await page.goto(`${cfg.base}/login`);
      await page.fill('input[name="email"]', "yousef@maple.com");
      await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
      await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOTS, "ref-maple-home.png"), fullPage: true });
    } else {
      await context.addCookies([{
        name: "sb-cadence-auth-token",
        value: mintCadenceJwt(),
        url: cfg.base,
      }]);
      await page.goto(cfg.base, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOTS, "ref-cadence-home.png"), fullPage: true });
    }
    await context.storageState({ path: statePath });
    console.log("setup ok:", page.url());
  }, { useState: false });
  reportErrors(`setup-${host}`);
} else if (command === "create") {
  const [label, prompt] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const before = await api(page, "GET", "/apps");
    const beforeIds = new Set((before.json ?? []).map((app) => app.id));
    const input = host === "maple"
      ? page.getByPlaceholder("Describe a new app")
      : page.getByLabel("Describe a new app");
    await input.fill(prompt);
    const started = Date.now();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    let created;
    if (host === "maple") {
      await waitBusyLabelCleared(page, /Creating…/);
      created = ((await api(page, "GET", "/apps")).json ?? [])
        .find((app) => !beforeIds.has(app.id));
    } else {
      created = await waitCreatedApp(page, beforeIds);
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    await settleSurface(page);
    await capture(page, label);
    console.log(`appId: ${created?.id ?? "UNKNOWN"}`);
    console.log(`name: ${created?.name ?? "?"}`);
    console.log(`timing: ${elapsed}s`);
  });
  reportErrors(rest[0]);
} else if (command === "open") {
  const [appId, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    if (host === "maple") await mapleSelectApp(page, appId);
    else await cadenceOpenApp(page, appId);
    await settleSurface(page);
    await capture(page, label);
    console.log("open ok");
  });
  reportErrors(rest[1]);
} else if (command === "fire") {
  // Action evidence: open the app, click the first enabled button whose
  // accessible name matches the regex, capture the resulting state (approval
  // card with payload where the tool is gated), then best-effort deny.
  const [appId, label, pattern] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    if (host === "maple") await mapleSelectApp(page, appId);
    else await cadenceOpenApp(page, appId);
    await settleSurface(page);
    const re = new RegExp(pattern, "i");
    const surface = page.locator(host === "maple" ? "[data-app-surface]" : 'section[aria-label="Open app"]');
    const buttons = surface.getByRole("button");
    const count = await buttons.count();
    let clicked = false;
    for (let i = 0; i < count; i += 1) {
      const name = (await buttons.nth(i).textContent().catch(() => "")) ?? "";
      if (re.test(name) && await buttons.nth(i).isEnabled().catch(() => false)) {
        await buttons.nth(i).click();
        console.log(`clicked: ${name.trim()}`);
        clicked = true;
        break;
      }
    }
    if (!clicked) console.log("clicked: NONE (no matching enabled button)");
    await page.waitForTimeout(6000);
    await capture(page, label);
    // Best-effort deny so no gated effect ever lands from the gate run.
    const deny = page.getByRole("button", { name: /deny|reject|cancel request|decline/i }).first();
    if (await deny.count() && await deny.isVisible().catch(() => false)) {
      await deny.click().catch(() => {});
      console.log("denied: yes");
      await page.waitForTimeout(1500);
    } else {
      console.log("denied: no gate visible");
    }
  });
  reportErrors(rest[1]);
} else if (command === "openaria") {
  // Open an app and capture aria snapshots of EVERY frame (islands live in
  // iframes, invisible to the page-level snapshot). Value-level judging aid
  // added during the 2026-07-26 re-gate; read-only, harness fix not tuning.
  const [appId, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    if (host === "maple") await mapleSelectApp(page, appId);
    else await cadenceOpenApp(page, appId);
    await settleSurface(page);
    await capture(page, label);
    let i = 0;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      i += 1;
      try {
        const aria = await frame.locator("body").ariaSnapshot();
        writeFileSync(join(SHOTS, `${label}.frame${i}.aria.yml`), aria);
      } catch (error) {
        console.log(`frame ${i} aria failed: ${error}`);
      }
    }
    console.log(`frames captured: ${i}`);
  });
  reportErrors(rest[1]);
} else if (command === "fireframe") {
  // Same as fire, but the control lives inside an island IFRAME (the plain
  // fire command's surface locator cannot reach into frames). Added during
  // the 2026-07-26 re-gate action-evidence pass; harness fix, not tuning.
  const [appId, label, pattern] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    if (host === "maple") await mapleSelectApp(page, appId);
    else await cadenceOpenApp(page, appId);
    await settleSurface(page);
    const re = new RegExp(pattern, "i");
    let clicked = false;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const buttons = frame.getByRole("button");
      const count = await buttons.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const name = (await buttons.nth(i).textContent().catch(() => "")) ?? "";
        if (re.test(name) && await buttons.nth(i).isEnabled().catch(() => false)) {
          await buttons.nth(i).click();
          console.log(`clicked: ${name.trim()}`);
          clicked = true;
          break;
        }
      }
      if (clicked) break;
    }
    if (!clicked) console.log("clicked: NONE (no matching enabled button in any frame)");
    await page.waitForTimeout(6000);
    await capture(page, label);
    const deny = page.getByRole("button", { name: /deny|reject|cancel request|decline/i }).first();
    if (await deny.count() && await deny.isVisible().catch(() => false)) {
      await deny.click().catch(() => {});
      console.log("denied: yes");
      await page.waitForTimeout(1500);
    } else {
      console.log("denied: no gate visible");
    }
  });
  reportErrors(rest[1]);
} else if (command === "hostjson") {
  // Ground truth for honest judging: fetch the HOST's own REST API as the
  // logged-in user (e.g. /api/accounts) and dump it as run evidence.
  const [path, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const result = await page.evaluate(async (p) => {
      const response = await fetch(p, { credentials: "include" });
      let json; try { json = await response.json(); } catch { json = null; }
      return { status: response.status, json };
    }, path);
    if (label) writeFileSync(join(SHOTS, `${label}.json`), JSON.stringify(result.json, null, 2));
    console.log(JSON.stringify(result, null, 2).slice(0, 6000));
  });
} else if (command === "getjson") {
  const [path, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const result = await api(page, "GET", path);
    if (label) writeFileSync(join(SHOTS, `${label}.json`), JSON.stringify(result.json, null, 2));
    console.log(JSON.stringify(result, null, 2).slice(0, 4000));
  });
} else {
  console.error("unknown command", command);
  process.exit(2);
}
