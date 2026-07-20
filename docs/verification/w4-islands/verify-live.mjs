/**
 * W4b live verification — drives a PRODUCTION demo-bank boot (next start on
 * :3000) through four FRESH island prompts (never the frozen 30 in
 * docs/eval/GOLDEN.md), each in its own isolated Chromium context:
 *
 *   p1 derivation island (Kit + fmt, no imports)
 *   p2 search-as-you-type read island (ambient tools read)
 *   p3 mutating island call → approval gate → approve → EFFECT LANDS (W0 seam)
 *   p4 interactive Kit-chart island
 *
 * Run: node docs/verification/w4-islands/verify-live.mjs [p1 p2 p3 p4]
 * Screenshots land beside this script (committed with git add -f).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const require = createRequire(join(repo, "packages", "ui", "package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.W4B_BASE_URL ?? "http://localhost:3000";
const shot = (name) => join(here, `${name}.png`);
const log = (...args) => console.log("[w4b]", ...args);
const wanted = process.argv.slice(2);
const runs = wanted.length === 0 ? ["p1", "p2", "p3", "p4"] : wanted;

const browser = await chromium.launch();
const results = {};

/** Fresh session: own context/page/thread. */
const session = async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[console-error]", m.text().slice(0, 200)); });
  await page.goto(`${BASE}/login`);
  await page.getByRole("textbox", { name: "Password" }).fill("maple-demo");
  await page.getByRole("textbox", { name: "Password" }).press("Enter");
  await page.waitForURL(`${BASE}/`, { timeout: 30_000 });
  await page.goto(`${BASE}/vendo`);
  return { context, page };
};

/** Newest island's frames on the page: [outerIframeLocator, innerFrame]. */
const newestIsland = (page) => {
  const outer = page.locator('iframe[title^="Generated component:"]').last();
  return { outer, inner: outer.contentFrame().locator("iframe").contentFrame() };
};

const createApp = async (page, prompt, ready, timeoutMs = 600_000) => {
  const composer = page.getByRole("textbox", { name: "Message" });
  // No click first: the floating voice blob can intercept the pointer, and
  // fill() needs only editability.
  await composer.fill(prompt);
  await composer.press("Enter");
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for island: ${prompt}`);
    try {
      const island = newestIsland(page);
      if ((await island.outer.count()) > 0 && await ready(island.inner)) {
        log(`island "${await island.outer.getAttribute("title")}" ready in ${Math.round((Date.now() - start) / 1000)}s`);
        await island.outer.scrollIntoViewIfNeeded();
        return island;
      }
    } catch { /* not mounted yet */ }
    await page.waitForTimeout(2_000);
  }
};

const capture = async (page, name, island) => {
  // The island's outer jail iframe IS the generated component — screenshot it
  // directly so overlays (voice blob, jump-to-latest) never hide the evidence.
  if (island !== undefined) {
    try {
      await island.outer.screenshot({ path: shot(name) });
      return;
    } catch { /* fall through to page */ }
  }
  await page.screenshot({ path: shot(name) });
};

const visible = (locator) => locator.isVisible({ timeout: 1000 }).catch(() => false);

// ---- p1: derivation island (Kit + fmt, no imports) --------------------------
if (runs.includes("p1")) {
  const { context, page } = await session();
  const island = await createApp(
    page,
    "build me a what-if savings calculator: I type a monthly contribution amount and it shows how many months until each of my savings goals is fully funded",
    (inner) => visible(inner.locator("input").first()),
  );
  const input = island.inner.locator("input").first();
  await input.fill("");
  await input.pressSequentially("500");
  await page.waitForTimeout(1_500);
  const text = await island.inner.locator("body").innerText();
  results.p1 = /mo/i.test(text) && /\$/.test(text);
  await capture(page, "p1-derivation-island", island);
  log("P1 derivation island:", results.p1 ? "PASS" : "CHECK", "-", text.slice(0, 200).replace(/\n/g, " | "));
  await context.close();
}

// ---- p2: search-as-you-type read island (ambient tools) ---------------------
if (runs.includes("p2")) {
  const { context, page } = await session();
  const island = await createApp(
    page,
    "build a live transaction search widget: a search box that looks up matching transactions from the server as I type and lists them with formatted amounts",
    (inner) => visible(inner.locator("input").first()),
  );
  const box = island.inner.locator("input").first();
  await box.pressSequentially("tartine", { delay: 120 });
  await island.inner.getByText(/tartine/i).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const text = await island.inner.locator("body").innerText();
  results.p2 = /tartine/i.test(text) && !/doordash/i.test(text);
  await capture(page, "p2-search-island", island);
  log("P2 search island:", results.p2 ? "PASS — server search filtered as typed" : "CHECK", "-", text.slice(0, 240).replace(/\n/g, " | "));
  await context.close();
}

// ---- p3: mutating island → approval → approve → effect lands ----------------
if (runs.includes("p3")) {
  const { context, page } = await session();
  const memo = `w4b-proof-${Date.now().toString(36)}`;
  const island = await createApp(
    page,
    `build a quick pay widget: an amount input and a Pay button that sends that amount to Jordan Avery with the memo "${memo}". show a live formatted preview of the amount as I type, and keep Pay disabled until the amount is valid`,
    (inner) => visible(inner.getByRole("button", { name: /pay/i }).first()),
  );
  // Test-env hygiene: repeated sessions accumulate unrelated pending
  // approvals (agent-side Slack asks). Deny them all so the ONLY pending
  // approval after Pay is this island's mutation.
  for (let drained = 0; drained < 100; drained += 1) {
    const deny = page.getByRole("button", { name: /^deny$/i }).first();
    if (!await deny.isVisible({ timeout: 1000 }).catch(() => false)) break;
    await deny.click();
    await page.waitForTimeout(400);
  }

  const amountBox = island.inner.locator("input").first();
  await amountBox.fill("");
  await amountBox.pressSequentially("41.37");
  await page.waitForTimeout(1_200);
  await island.inner.getByRole("button", { name: /pay/i }).first().click({ force: true });

  // The approval gate: the guard parks the destructive call and the surface
  // asks. Make sure the card on screen is THIS mutation before approving.
  const approve = page.getByRole("button", { name: /approve/i }).first();
  await approve.waitFor({ timeout: 90_000 });
  await page.getByText(/transfer|jordan|order/i).first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: shot("p3-approval-pending") });
  log("P3 approval gate reached (destructive tool parked at approval)");
  await approve.click();

  // W0 approve→resume: the parked call re-dispatches and the EFFECT LANDS —
  // a posted transfer to Jordan Avery for exactly -$41.37.
  const start = Date.now();
  let landed = false;
  while (Date.now() - start < 90_000) {
    // Route responses are ok()-wrapped: { data: { data: rows, ... } }.
    const response = await page.request.get(`${BASE}/api/transactions?limit=20`);
    if (response.ok()) {
      const body = await response.json().catch(() => ({}));
      const rows = body?.data?.data ?? [];
      const hit = rows.find((txn) => txn.amount === -4137);
      if (hit) {
        landed = true;
        log("P3 effect:", JSON.stringify({ merchant: hit.merchant, amount: hit.amount, descriptor: hit.descriptor, notes: hit.notes }));
        break;
      }
    }
    await page.waitForTimeout(2_000);
  }
  results.p3 = landed;
  await page.waitForTimeout(2_000);
  await capture(page, "p3-approved-effect", island);
  log("P3 mutating island end-to-end:", landed
    ? "PASS — transfer POSTED after approval (approve→resume, effect landed)"
    : "FAIL — effect not found in /api/transactions");
  await context.close();
}

// ---- p4: interactive Kit-chart island ----------------------------------------
if (runs.includes("p4")) {
  const { context, page } = await session();
  const island = await createApp(
    page,
    "build an interactive category comparison: let me pick any two spending categories from dropdowns and show a bar chart comparing their totals this month",
    async (inner) => await visible(inner.locator("select").first()) && /\$/.test(await inner.locator("body").innerText().catch(() => "")),
  );
  const before = await island.inner.locator("body").innerText();
  const picker = island.inner.locator("select").first();
  const values = await picker.locator("option").evaluateAll((options) => options.map((option) => option.value));
  await picker.selectOption(values[values.length - 1]);
  await page.waitForTimeout(1_500);
  const after = await island.inner.locator("body").innerText();
  results.p4 = before !== after && /\$/.test(after);
  await capture(page, "p4-chart-island", island);
  log("P4 chart island:", results.p4 ? "PASS — picker re-computed the chart" : "CHECK", "-", after.slice(0, 200).replace(/\n/g, " | "));
  await context.close();
}

log("results", JSON.stringify(results));
await browser.close();
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
