/**
 * REMIX baseline run driver — dedicated headless Playwright instance (never
 * the shared MCP browser), driving the REAL Apps surfaces on the production
 * demo hosts. One invocation per step; screenshots + wire JSON land in this
 * directory as run evidence. Storage states (session cookies) stay in the
 * session scratchpad, never in the repo.
 *
 * Usage:
 *   node driver.mjs setup <host>
 *   node driver.mjs create <host> <label> <prompt>
 *   node driver.mjs edit <host> <appId> <label> <instruction>
 *   node driver.mjs open <host> <appId> <label>
 *   node driver.mjs shipdiff <host> <appId> <label>
 *   node driver.mjs appdoc <host> <appId> <label>
 *   node driver.mjs drift <host> <appId>
 *   node driver.mjs rebase <host> <appId> <slot>
 * hosts: maple (http://localhost:3100, /vendo/apps UI edit box)
 *        cadence (http://localhost:3300, VendoPage apps tab; edits via the
 *        same wire call the UI client uses, from the page context)
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const { chromium } = await import(
  join(root, "node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs")
);

const SCRATCH = process.env.REMIX_SCRATCH
  ?? "/private/tmp/claude-501/-Users-yousefh-orca-workspaces-flowlet-format-improvments/bdf6fdbf-b686-44da-beb2-1c7e54d6c2fc/scratchpad";
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

async function settleSurface(page, ms = 6000) {
  await page.waitForTimeout(ms);
}

async function mapleSelectApp(page, appId) {
  const doc = await api(page, "GET", `/apps/${appId}`);
  if (doc.status !== 200) throw new Error(`app ${appId} not found: ${doc.status}`);
  // Names collide (every base app is "My Corner"), so click by LIST INDEX:
  // the chip row renders the apps in the same order GET /apps returns them.
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
  await page.getByRole("tab", { name: /apps/i }).click().catch(async () => {
    await page.getByRole("button", { name: /^apps$/i }).click();
  });
  const card = page.locator("article", { hasText: doc.json.name }).first();
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
  const secret = "super-secret-jwt-token-with-at-least-32-characters-long";
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
      await page.fill('input[name="password"]', "maple-demo");
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
    // The create button is disabled/busy until POST /apps resolves.
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll("button")];
      return !buttons.some((button) => /Creating…/.test(button.textContent ?? ""));
    }, undefined, { timeout: 240_000 });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    await settleSurface(page);
    await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: true });
    const after = await api(page, "GET", "/apps");
    const created = (after.json ?? []).find((app) => !beforeIds.has(app.id));
    console.log(`appId: ${created?.id ?? "UNKNOWN"}`);
    console.log(`name: ${created?.name ?? "?"}`);
    console.log(`timing: ${elapsed}s`);
  });
  reportErrors(rest[0]);
} else if (command === "edit") {
  const [appId, label, instruction] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    if (host === "maple") {
      await mapleSelectApp(page, appId);
      await page.waitForTimeout(2000);
      const input = page.locator('form[aria-label="Edit app"] input');
      await input.fill(instruction);
      const started = Date.now();
      await page.locator('form[aria-label="Edit app"] button[type="submit"]').click();
      await page.waitForFunction(() => {
        const buttons = [...document.querySelectorAll("button")];
        return !buttons.some((button) => /Editing…/.test(button.textContent ?? ""));
      }, undefined, { timeout: 240_000 });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const alert = page.locator('p[role="alert"]');
      const issue = (await alert.count()) > 0 ? await alert.first().textContent() : "";
      await settleSurface(page);
      await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: true });
      console.log(`timing: ${elapsed}s`);
      if (issue) console.log(`edit-issues: ${issue}`);
    } else {
      const started = Date.now();
      const result = await api(page, "POST", `/apps/${appId}/edit`, { instruction });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`timing: ${elapsed}s`);
      console.log(`edit-status: ${result.status}`);
      if (result.json?.issues) console.log(`edit-issues: ${JSON.stringify(result.json.issues)}`);
      await gotoApps(page);
      await cadenceOpenApp(page, appId);
      await settleSurface(page);
      await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: true });
    }
  });
  reportErrors(rest[1]);
} else if (command === "open") {
  const [appId, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    if (host === "maple") await mapleSelectApp(page, appId);
    else await cadenceOpenApp(page, appId);
    await settleSurface(page);
    await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: true });
    console.log("open ok");
  });
  reportErrors(rest[1]);
} else if (command === "shipdiff") {
  const [appId, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const result = await api(page, "GET", `/apps/${appId}/ship-diff`);
    writeFileSync(join(SHOTS, `${label}.json`), JSON.stringify(result.json, null, 2));
    console.log(`shipdiff-status: ${result.status}`);
    const pins = result.json?.pins ?? [];
    console.log(`pins: ${JSON.stringify(pins.map((pin) => ({ slot: pin.slot, drifted: pin.drifted, diffBytes: pin.diff.length })))}`);
    console.log(`generated: ${JSON.stringify((result.json?.generated ?? []).map((entry) => entry.component))}`);
    if (host === "maple") {
      await mapleSelectApp(page, appId);
      await page.getByRole("button", { name: "Load ship-diff" }).click();
      await page.waitForSelector("[data-ship-diff]", { timeout: 30_000 });
      await page.waitForTimeout(800);
      const card = page.locator("[data-ship-diff]");
      await card.screenshot({ path: join(SHOTS, `${label}.png`) });
    }
  });
} else if (command === "appdoc") {
  const [appId, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const doc = await api(page, "GET", `/apps/${appId}`);
    writeFileSync(join(SHOTS, `${label}.json`), JSON.stringify(doc.json, null, 2));
    console.log(`pins: ${JSON.stringify(doc.json?.pins ?? [])}`);
    console.log(`components: ${JSON.stringify(Object.keys(doc.json?.components ?? {}))}`);
    console.log(`nodes: ${JSON.stringify((doc.json?.tree?.nodes ?? []).map((node) => `${node.component}(${node.source ?? "?"})`))}`);
  });
} else if (command === "getjson") {
  const [path, label] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const result = await api(page, "GET", path);
    if (label) writeFileSync(join(SHOTS, `${label}.json`), JSON.stringify(result.json, null, 2));
    console.log(JSON.stringify(result, null, 2).slice(0, 4000));
  });
} else if (command === "drift") {
  const [appId] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const result = await api(page, "GET", `/apps/${appId}/pin-drift`);
    console.log(JSON.stringify(result, null, 2));
  });
} else if (command === "rebase") {
  const [appId, slot] = rest;
  await withPage(async (page) => {
    await gotoApps(page);
    const result = await api(page, "POST", `/apps/${appId}/rebase-pin`, { slot });
    writeFileSync(join(SHOTS, `rebase-${appId}.json`), JSON.stringify(result.json, null, 2));
    console.log(JSON.stringify({ status: result.status, ...result.json }, null, 2));
  });
} else {
  console.error("unknown command", command);
  process.exit(2);
}
