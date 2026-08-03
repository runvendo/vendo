/**
 * REMIX frozen-12 re-run driver — 2026-08-03, final wrapper shape.
 *
 * One subcommand per scenario (node driver.mjs rm1 …), dedicated headless
 * Playwright Chromium (never a shared browser). Every measured step is
 * executed ONCE; the driver only captures evidence (screenshots to shots/,
 * wire artifacts to wire/) — verdicts are judged from the artifacts against
 * docs/eval/REMIX.md.
 *
 * Gesture surface (2026-08-02 final shape): the wrapper's ✦ Remix affordance
 * is `POST /apps/fork-pin` — the plain add-as-is gesture is the REAL pill
 * click; an instruction-carrying gesture is the same wire call with the
 * frozen protocol's `{ slot, instruction }` body, invoked from the page
 * context with the session's credentials.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../packages/ui/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const HOST = process.env.EVAL_HOST ?? "maple"; // maple | cadence
const BASE = HOST === "maple" ? "http://localhost:4310/maple" : "http://localhost:4311/cadence";
const API = `${BASE}/api/vendo`;
const BASE_PROMPT = HOST === "maple"
  ? "a page with just a heading that says 'My corner'"
  : "a page with just a heading that says 'Week ahead'";
const SLOT = HOST === "maple" ? "NetWorthView" : "MissingDocsHero";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const hash8 = (slot) => createHash("sha256").update(slot).digest("hex").slice(0, 8);
const PIN_COMPONENT = `Pinned${SLOT}${hash8(SLOT)}`;

const log = (...parts) => console.log(new Date().toISOString(), "—", ...parts);
await mkdir(path.join(DIR, "shots"), { recursive: true });
await mkdir(path.join(DIR, "wire"), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleLog = [];
page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));

const shot = async (name, full = true) => {
  await page.screenshot({ path: path.join(DIR, "shots", `${name}.png`), fullPage: full });
  log(`📸 ${name}.png`);
};
const save = async (name, data) => {
  await writeFile(path.join(DIR, "wire", `${name}.json`), JSON.stringify(data, null, 2));
  log(`💾 wire/${name}.json`);
};

/** In-page fetch riding the session's own credentials — the wire the page's
 *  client uses (json content-type satisfies the CSRF json-mutation gate). */
async function api(method, route, body) {
  const started = Date.now();
  const out = await page.evaluate(async ({ apiBase, method, route, body }) => {
    const res = await fetch(`${apiBase}${route}`, {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    let json;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }, { apiBase: API, method, route, body });
  return { ...out, ms: Date.now() - started };
}

async function signIn() {
  if (HOST === "maple") {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
    await Promise.all([page.waitForURL(/\/maple\/?$/), page.click('button[type="submit"]')]);
    await page.waitForSelector(`[data-vendo-remixable="${SLOT}"]`, { state: "attached", timeout: 30_000 });
  } else {
    await page.goto(`${BASE}/`); // DEMO_AUTOLOGIN=1 signs the seeded user in
    await page.waitForSelector(`[data-vendo-remixable="${SLOT}"]`, { timeout: 30_000 });
  }
  log("signed in");
}

/** STAGING — wipe this subject's apps so fork dedupe never crosses scenarios. */
async function resetApps() {
  const list = await api("GET", "/apps");
  for (const app of list.json ?? []) await api("DELETE", `/apps/${app.id}`);
  log(`staging: deleted ${list.json?.length ?? 0} app(s)`);
}

/** STAGING — the scenario's fresh base app, fixed prompt, real create path
 *  (Maple: the /vendo/apps create form; Cadence: the wire create the page's
 *  client uses — its shipped surface has no create form). Infra retry only. */
async function createBaseApp() {
  const started = Date.now();
  if (HOST === "maple") {
    await page.goto(`${BASE}/vendo/apps`);
    await page.fill('form[aria-label="Create app"] input', BASE_PROMPT);
    await page.click('form[aria-label="Create app"] button[type="submit"]');
    await page.waitForSelector('form[aria-label="Create app"] button:has-text("Creating…")', { timeout: 10_000 }).catch(() => {});
    await page.waitForSelector('form[aria-label="Create app"] button:text-is("Create")', { timeout: 300_000 });
  } else {
    const res = await api("POST", "/apps", { prompt: BASE_PROMPT });
    if (res.status !== 200) throw new Error(`base create failed: ${res.status} ${JSON.stringify(res.json)}`);
  }
  const apps = (await api("GET", "/apps")).json ?? [];
  // The demo store re-seeds its showcase apps (app_demo_*) on list — the
  // scenario's base app is the newest NON-seeded, pin-less row.
  const base = apps.filter((a) => !a.id.startsWith("app_demo") && !(a.pins?.length)).at(-1);
  log(`staging: base app ${base?.id} (“${base?.name}”) in ${Math.round((Date.now() - started) / 1000)}s`);
  return base;
}

/** MEASURED — the instruction-carrying Remix gesture on the wrapper slot:
 *  one fork-pin wire call from the page context (frozen protocol shape). */
async function gestureFork(instruction, tag) {
  const body = instruction === undefined ? { slot: SLOT } : { slot: SLOT, instruction };
  log(`gesture fork-pin${instruction ? ` «${instruction}»` : " (plain)"} …`);
  const res = await api("POST", "/apps/fork-pin", body);
  await save(`${tag}-forkpin`, { request: body, status: res.status, wireMs: res.ms, response: res.json });
  log(`fork-pin answered ${res.status} in ${(res.ms / 1000).toFixed(1)}s`);
  return res;
}

/** MEASURED (R-M2 A) — the plain add-as-is gesture through the REAL ✦ pill. */
async function gestureForkViaPill() {
  await page.goto(`${BASE}/`);
  const wrapper = page.locator(`[data-vendo-remixable="${SLOT}"]`);
  await wrapper.waitFor({ timeout: 30_000 });
  await wrapper.hover();
  const pill = wrapper.locator(`button[aria-label="Remix ${SLOT} with Vendo"]`);
  const started = Date.now();
  await pill.click();
  await page.waitForSelector(`iframe[title="Generated component: ${PIN_COMPONENT}"]`, { timeout: 60_000 });
  const ms = Date.now() - started;
  await page.waitForTimeout(4_000);
  log(`✦ pill fork mounted in place in ${(ms / 1000).toFixed(1)}s`);
  return ms;
}

/** Render the fork in place (fresh load) and let the jail paint. */
async function openForkInPlace(timeout = 90_000) {
  await page.goto(`${BASE}/`);
  await page.waitForSelector(`iframe[title="Generated component: ${PIN_COMPONENT}"]`, { timeout });
  await page.waitForTimeout(5_000);
}

const forkApp = async () => ((await api("GET", "/apps")).json ?? []).find((a) => a.pins?.some((p) => p.slot === SLOT));
const appDoc = async (id) => (await api("GET", `/apps/${id}`)).json;

/** MEASURED — Maple text edit through the /vendo/apps edit box (the real
 *  POST /apps/:id/edit path), timed submit → busy label gone. */
async function editViaMapleUI(appName, instruction, tag) {
  await page.goto(`${BASE}/vendo/apps`);
  await page.waitForSelector('[role="list"][aria-label="Your apps"]', { timeout: 15_000 });
  await page.click(`[role="list"][aria-label="Your apps"] button:text-is("${appName}")`);
  await page.waitForSelector('form[aria-label="Edit app"]', { timeout: 15_000 });
  await page.fill('form[aria-label="Edit app"] input', instruction);
  const started = Date.now();
  await page.click('form[aria-label="Edit app"] button[type="submit"]');
  await page.waitForSelector('form[aria-label="Edit app"] button:has-text("Editing…")', { timeout: 10_000 }).catch(() => {});
  await page.waitForSelector('form[aria-label="Edit app"] button:text-is("Edit")', { timeout: 360_000 });
  const ms = Date.now() - started;
  const alert = await page.locator('p[role="alert"]').first().textContent().catch(() => null);
  log(`edit finished in ${(ms / 1000).toFixed(1)}s${alert ? ` — surfaced error: ${alert}` : ""}`);
  await save(`${tag}-edit`, { instruction, ms, surfacedError: alert });
  return { ms, alert };
}

/** MEASURED — Cadence text edit: the same POST /apps/:id/edit wire call from
 *  the page context (its shipped surface has no edit input), judged on the
 *  reopened rendered app. */
async function editViaWire(appId, instruction, tag) {
  log(`wire edit on ${appId}: «${instruction}» …`);
  const res = await api("POST", `/apps/${appId}/edit`, { instruction });
  await save(`${tag}-edit`, { appId, instruction, status: res.status, wireMs: res.ms, response: res.json });
  log(`edit answered ${res.status} in ${(res.ms / 1000).toFixed(1)}s`);
  return res;
}

async function captureShipDiff(appId, tag) {
  const res = await api("GET", `/apps/${appId}/ship-diff`);
  await save(`${tag}-shipdiff`, res.json);
  return res.json;
}
async function captureAppDoc(appId, tag) {
  const doc = await appDoc(appId);
  await save(`${tag}-appdoc`, doc);
  return doc;
}

/** Maple ship-review panel shot (the judged ship-diff surface). */
async function shotShipReviewUI(appName, name) {
  await page.goto(`${BASE}/vendo/apps`);
  await page.waitForSelector('[role="list"][aria-label="Your apps"]', { timeout: 15_000 });
  await page.click(`[role="list"][aria-label="Your apps"] button:text-is("${appName}")`);
  await page.click('button:has-text("Load ship-diff")');
  await page.waitForSelector("[data-ship-diff]", { timeout: 20_000 });
  await page.waitForTimeout(1_000);
  await shot(name);
}

/** Open the fork app on Maple's /vendo/apps panel and screenshot it. */
async function shotAppPanel(appName, name, settle = 4_000) {
  await page.goto(`${BASE}/vendo/apps`);
  await page.waitForSelector('[role="list"][aria-label="Your apps"]', { timeout: 15_000 });
  await page.click(`[role="list"][aria-label="Your apps"] button:text-is("${appName}")`);
  await page.waitForSelector("[data-app-surface]", { timeout: 30_000 });
  await page.waitForTimeout(settle);
  await shot(name);
}

const scenario = process.argv[2];
if (!scenario) { console.error("usage: node driver.mjs <ref|rm1|rm2|...>"); process.exit(2); }

try {
  await signIn();

  // ---------------- Maple ----------------
  if (scenario === "ref") {
    // Reference shots: the host's own render of the slot — the fidelity bar.
    await page.waitForTimeout(3_000);
    await shot(`ref-${HOST}-home`);
  }

  if (scenario === "rm1") {
    await resetApps();
    await createBaseApp();
    const res = await gestureFork("also show the change in dollars for the selected range under the big number", "R-M1");
    await openForkInPlace();
    await shot("R-M1-A");
    const fork = await forkApp();
    if (fork) {
      await captureAppDoc(fork.id, "R-M1");
      await captureShipDiff(fork.id, "R-M1-A");
      await shotShipReviewUI(fork.name, "R-M1-A-shipdiff-ui");
    }
  }

  if (scenario === "rm2") {
    await resetApps();
    await createBaseApp();
    const ms = await gestureForkViaPill(); // (A) plain gesture, REAL pill
    await save("R-M2-forkpin", { via: "real ✦ pill", visibleMs: ms });
    await shot("R-M2-A");
    let fork = await forkApp();
    await captureAppDoc(fork.id, "R-M2-A");
    await captureShipDiff(fork.id, "R-M2-A");
    // (B) text edit on the fork app through the real edit box
    await editViaMapleUI(fork.name, "make the change badge blue instead of green", "R-M2-B");
    await openForkInPlace();
    await shot("R-M2-B");
    await captureAppDoc(fork.id, "R-M2-B");
    await captureShipDiff(fork.id, "R-M2-B");
    await shotShipReviewUI(fork.name, "R-M2-B-shipdiff-ui");
  }

  if (scenario === "rm3") {
    await resetApps();
    await createBaseApp();
    await gestureFork("make the range switcher only offer 1M and 1Y", "R-M3");
    await openForkInPlace();
    await shot("R-M3-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-M3-A");
    await captureShipDiff(fork.id, "R-M3-A");
    // (B) caption edit
    await editViaMapleUI(fork.name, "add a small caption under the chart that says 'Excludes pending transactions'", "R-M3-B");
    await openForkInPlace();
    await shot("R-M3-B");
    // interactivity probe: click the 1Y range inside the jail via raw mouse
    const frameEl = page.locator(`iframe[title="Generated component: ${PIN_COMPONENT}"]`);
    const frame = await (await frameEl.elementHandle()).contentFrame();
    if (frame) {
      const button = frame.locator('button:text-is("1Y")').first();
      if (await button.count()) { await button.click(); await page.waitForTimeout(1_500); }
    }
    await shot("R-M3-B-after-1Y-click");
    await captureAppDoc(fork.id, "R-M3-B");
    await captureShipDiff(fork.id, "R-M3-B");
    await shotShipReviewUI(fork.name, "R-M3-B-shipdiff-ui");
  }

  if (scenario === "rm4") {
    await resetApps();
    const base = await createBaseApp();
    await shotAppPanel(base.name, "R-M4-base");
    await editViaMapleUI(base.name, "add the bank's net worth card to this page, exactly as it is", "R-M4-A");
    await shotAppPanel(base.name, "R-M4-A");
    await captureAppDoc(base.id, "R-M4");
    await captureShipDiff(base.id, "R-M4-A");
  }

  if (scenario === "rm5") {
    await resetApps();
    await createBaseApp();
    await gestureFork("make the title say 'Savings power' instead of 'Total balance'", "R-M5");
    await openForkInPlace();
    await shot("R-M5-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-M5-A");
    await captureShipDiff(fork.id, "R-M5-A");
    await editViaMapleUI(fork.name, "add a table of my accounts with their balances below the card", "R-M5-B");
    await openForkInPlace();
    await shot("R-M5-B");
    await captureAppDoc(fork.id, "R-M5-B");
    await captureShipDiff(fork.id, "R-M5-B");
    await shotShipReviewUI(fork.name, "R-M5-B-shipdiff-ui");
  }

  if (scenario === "rm6a") {
    await resetApps();
    await createBaseApp();
    await gestureFork("make the default range 1Y", "R-M6");
    await openForkInPlace();
    await shot("R-M6-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-M6-A");
    await captureShipDiff(fork.id, "R-M6-A");
    console.log(`FORK_APP=${fork.id}`);
  }

  if (scenario === "rm6b") {
    // After host-source staging + re-sync + restart: drift checks.
    await openForkInPlace().catch(() => {}); // drift may render notice instead
    await page.waitForTimeout(4_000);
    await shot("R-M6-B-drift-notice");
    const fork = await forkApp();
    const drift = await api("GET", `/apps/${fork.id}/pin-drift`);
    await save("R-M6-B-pindrift", drift.json);
    await captureShipDiff(fork.id, "R-M6-B");
  }

  if (scenario === "rm6c") {
    const fork = await forkApp();
    log("invoking explicit rebase …");
    const res = await api("POST", `/apps/${fork.id}/rebase-pin`, { slot: SLOT });
    await save("R-M6-C-rebase", { status: res.status, wireMs: res.ms, response: res.json });
    await openForkInPlace();
    await shot("R-M6-C-after-rebase");
    const drift = await api("GET", `/apps/${fork.id}/pin-drift`);
    await save("R-M6-C-pindrift-after", drift.json);
    await captureAppDoc(fork.id, "R-M6-C");
    await captureShipDiff(fork.id, "R-M6-C");
  }

  // ---------------- Cadence ----------------
  if (scenario === "rc1") {
    await resetApps();
    await createBaseApp();
    await gestureFork("also show what percent of clients are fully complete", "R-C1");
    await openForkInPlace();
    await shot("R-C1-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-C1");
    await captureShipDiff(fork.id, "R-C1-A");
  }

  if (scenario === "rc2") {
    await resetApps();
    await createBaseApp();
    await gestureFork("show the week-over-week change in clients missing documents", "R-C2");
    await openForkInPlace();
    await shot("R-C2-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-C2");
    await captureShipDiff(fork.id, "R-C2-A");
  }

  if (scenario === "rc3") {
    await resetApps();
    await createBaseApp();
    await gestureFork("make the badge say 'Chase these'", "R-C3");
    await openForkInPlace();
    await shot("R-C3-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-C3-A");
    await captureShipDiff(fork.id, "R-C3-A");
    await editViaWire(fork.id, "make the big number amber when more than half of active clients are missing documents", "R-C3-B");
    await openForkInPlace();
    await shot("R-C3-B");
    await captureAppDoc(fork.id, "R-C3-B");
    await captureShipDiff(fork.id, "R-C3-B");
  }

  if (scenario === "rc4") {
    await resetApps();
    const base = await createBaseApp();
    await editViaWire(base.id, "add the missing documents hero card to this page as-is", "R-C4-A");
    await page.goto(`${BASE}/assistant`);
    await page.waitForTimeout(3_000);
    await shot("R-C4-assistant");
    await captureAppDoc(base.id, "R-C4");
    await captureShipDiff(base.id, "R-C4-A");
  }

  if (scenario === "rc5") {
    await resetApps();
    const base = await createBaseApp();
    await editViaWire(base.id, "a section with the missing documents hero on top and a table of clients with outstanding documents below it", "R-C5-A");
    await captureAppDoc(base.id, "R-C5");
    await captureShipDiff(base.id, "R-C5-A");
  }

  if (scenario === "rc6") {
    await resetApps();
    await createBaseApp();
    await gestureFork("make the label read 'Clients still owing documents'", "R-C6");
    await openForkInPlace();
    await shot("R-C6-A");
    const fork = await forkApp();
    await captureAppDoc(fork.id, "R-C6-A");
    await captureShipDiff(fork.id, "R-C6-A");
    await editViaWire(fork.id, "add a donut of documents by status next to it", "R-C6-B");
    await openForkInPlace();
    await shot("R-C6-B");
    await captureAppDoc(fork.id, "R-C6-B");
    await captureShipDiff(fork.id, "R-C6-B");
  }
} finally {
  await writeFile(path.join(DIR, "wire", `console-${scenario}.log.txt`), consoleLog.join("\n"));
  await browser.close();
}
