/**
 * W1e — ONE continuous real-browser E2E over demo-bank (Maple) on the
 * wrapper API (2026-08-02 remix final shape). Steps a–d per the executor
 * checklist; a screenshot lands beside this script at every lettered step.
 *
 * Prereqs (the driving session starts these):
 *   cd examples/demo-bank && pnpm exec next build && \
 *   MAPLE_STORE=local MAPLE_DEV_SEAMS=1 AUTH_SECRET=w1e-local \
 *   MAPLE_DEMO_PASSWORD=maple-demo pnpm exec next start -p 4310
 *
 * Run: node docs/verification/remix-final-shape-e2e/run-e2e.mjs
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../packages/ui/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");

const BASE = process.env.E2E_BASE ?? "http://localhost:4310";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const hash8 = (slot) => createHash("sha256").update(slot).digest("hex").slice(0, 8);
const FORK_NETWORTH = `PinnedNetWorthView${hash8("NetWorthView")}`;
const FORK_QUICKACTIONS = `PinnedQuickActionsView${hash8("QuickActionsView")}`;

const log = (...parts) => console.log(new Date().toISOString(), "—", ...parts);
const results = [];
const pass = (step, note) => { results.push({ step, verdict: "PASS", note }); log(`✅ ${step}: ${note}`); };
const fail = (step, note) => { results.push({ step, verdict: "FAIL", note }); log(`❌ ${step}: ${note}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleLog = [];
page.on("console", (message) => consoleLog.push(`[${message.type()}] ${message.text()}`));

const shot = async (name) => {
  await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: false });
  log(`📸 ${name}.png`);
};

/** The wrapper's ✦ pill only blooms on pointer presence — hover, then click. */
async function remixPill(slot) {
  const wrapper = page.locator(`[data-vendo-remixable="${slot}"]`);
  await wrapper.hover();
  return wrapper.locator(`button[aria-label="Remix ${slot} with Vendo"]`);
}
async function managePill(slot) {
  const wrapper = page.locator(`[data-vendo-remixable="${slot}"]`);
  await wrapper.hover();
  return wrapper.locator(`button[aria-label="Manage the ${slot} remix"]`);
}
async function popoverStatus(slot) {
  const pill = await managePill(slot);
  await pill.click();
  const status = page.locator(`[role="group"][aria-label="Remix of ${slot}"] [role="status"]`);
  await status.waitFor({ state: "visible", timeout: 15_000 });
  // The status line settles once the open payload arrives.
  await page.waitForTimeout(1_500);
  return status;
}
async function closePopover() {
  await page.keyboard.press("Escape");
}

const jailFrame = (component) => page.frameLocator(`iframe[title="Generated component: ${component}"]`);
const jailCount = (component) => page.locator(`iframe[title="Generated component: ${component}"]`).count();
const nativeCount = (component) => page.locator(`[data-vendo-inclient-mount="${component}"]`).count();

try {
  // ---- Sign in (real Auth.js credentials form) --------------------------
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await Promise.all([page.waitForURL(`${BASE}/`), page.click('button[type="submit"]')]);
  await page.waitForSelector("text=Total balance", { timeout: 30_000 });
  await shot("00-signed-in-home");
  log("signed in; home rendered");

  // ---- (a) instant-kind: fork in place, edit via panel, revert, re-fork --
  {
    const pill = await remixPill("NetWorthView");
    await pill.click();
    await page.waitForSelector(`iframe[title="Generated component: ${FORK_NETWORTH}"]`, { timeout: 60_000 });
    // The fork renders IN PLACE, sandboxed, with the page's real data.
    const frame = jailFrame(FORK_NETWORTH);
    await frame.locator("text=Total balance").waitFor({ timeout: 60_000 });
    const forkHasMoney = (await frame.locator("body").innerText()).includes("$");
    await shot("a1-fork-jailed-in-place");
    if (forkHasMoney) pass("a1", "✦ fork mounted sandboxed IN PLACE with the page's real data (live $ total inside the jail)");
    else fail("a1", "fork mounted but no live money value visible in the jail");

    // Edit via the panel: ✦ popover → Open in panel → prefilled composer.
    await (await managePill("NetWorthView")).click();
    await page.click('button:has-text("Open in panel")');
    const composer = page.locator('textarea[aria-label="Message"]');
    await composer.waitFor({ timeout: 15_000 });
    const prefilled = await composer.inputValue();
    if (!prefilled.startsWith("Update my NetWorthView remix")) {
      fail("a2", `panel opened without the remix-scoped prefill (got "${prefilled}")`);
    }
    await composer.fill(`${prefilled}change the label "Total balance" to "Net worth (remixed)" — nothing else.`);
    await page.click('button[aria-label="Send"]');
    log("edit sent through the panel; waiting for the fork to update…");
    let edited = false;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      try {
        if ((await jailFrame(FORK_NETWORTH).locator("body").innerText()).includes("Net worth (remixed)")) { edited = true; break; }
      } catch { /* frame remounting between polls */ }
      await page.waitForTimeout(3_000);
      if (Date.now() > deadline - 120_000 && !edited) {
        // The wrapper's one-shot open() may predate the edit — one reload is a
        // legitimate user gesture in the same session.
        await page.reload();
        await page.waitForSelector("text=Total balance", { timeout: 30_000 }).catch(() => {});
      }
    }
    await page.keyboard.press("Escape");
    await shot("a2-fork-edited-via-panel");
    if (edited) pass("a2", "panel edit landed — the fork re-rendered with the instructed label");
    else fail("a2", "panel edit did not surface in the fork within 240s");

    // Revert to original.
    await (await managePill("NetWorthView")).click();
    await page.click('button:has-text("Revert to original")');
    await page.waitForFunction(
      (title) => document.querySelectorAll(`iframe[title="${title}"]`).length === 0,
      `Generated component: ${FORK_NETWORTH}`,
      { timeout: 30_000 },
    );
    await page.waitForSelector("text=Total balance", { timeout: 15_000 });
    await shot("a3-reverted-original-back");
    pass("a3", "revert removed the fork; the host's original renders again");

    // Remix again — the affordance survives the round trip.
    const pillAgain = await remixPill("NetWorthView");
    await pillAgain.click();
    await page.waitForSelector(`iframe[title="Generated component: ${FORK_NETWORTH}"]`, { timeout: 60_000 });
    await shot("a4-remixed-again");
    pass("a4", "second ✦ remix forked again after the revert");
  }

  // ---- (b) review-kind: sent for review → REAL seam approval → native ---
  {
    const pill = await remixPill("QuickActionsView");
    await pill.click();
    // The original must STAY: no jailed fork for review-kind, ever.
    await (await managePill("QuickActionsView")).waitFor({ timeout: 60_000 });
    const status = await popoverStatus("QuickActionsView");
    const sent = (await status.innerText()).includes("Sent for review");
    const stillOriginal = (await page.locator('button:has-text("Move money")').count()) > 0;
    const jailed = await jailCount(FORK_QUICKACTIONS);
    await shot("b1-sent-for-review-original-stays");
    await closePopover();
    if (sent && stillOriginal && jailed === 0) pass("b1", "review-kind remix reports “sent for review”; the original stays; nothing jailed");
    else fail("b1", `sent=${sent} originalStays=${stillOriginal} jailedFrames=${jailed}`);

    // The REAL review seam (wire, dev-composition scoped): queue → approve.
    const queueResponse = await page.request.get(`${BASE}/api/vendo/apps/review-queue`);
    const queue = await queueResponse.json();
    await writeFile(path.join(DIR, "b2-review-queue.json"), JSON.stringify(queue, null, 2));
    const entry = queue.find((candidate) => candidate.slot === "QuickActionsView");
    if (!entry || !entry.shipDiff) fail("b2", `review queue did not list the fork (${JSON.stringify(queue).slice(0, 200)})`);
    else {
      log(`review queue lists ${entry.appId} @ ${entry.versionHash} with a ship-diff (${entry.shipDiff.files?.length ?? "?"} file(s))`);
      const approve = await page.request.post(`${BASE}/api/vendo/dev/inclient-approval`, {
        data: { appId: entry.appId, approvedBy: "host-reviewer (dev seam)" },
      });
      if (!approve.ok()) fail("b2", `approval door answered ${approve.status()}`);
      else pass("b2", "approved through the REAL wire seam (review-queue + in-client approval door)");
    }

    // The venue verdict is served on open(): re-open the page (same session).
    await page.reload();
    await page.waitForSelector("text=Total balance", { timeout: 30_000 });
    await page.waitForSelector(`[data-vendo-inclient-mount="${FORK_QUICKACTIONS}"]`, { timeout: 60_000 });
    const nativeJailed = await jailCount(FORK_QUICKACTIONS);
    const statusAfter = await popoverStatus("QuickActionsView");
    const approvedLine = await statusAfter.innerText();
    await shot("b3-approved-native-in-place");
    await closePopover();
    if (nativeJailed === 0 && approvedLine.includes("runs in the page")) {
      pass("b3", `approved fork mounts NATIVE in place (no iframe); popover: “${approvedLine}”`);
    } else {
      fail("b3", `native mount check failed (jailedFrames=${nativeJailed}, status “${approvedLine}”)`);
    }
  }

  // ---- (c) reject path: fresh fork → reject with note → note in panel ---
  {
    // Revert the approved remix, fork anew (pending), then the reviewer rejects.
    await (await managePill("QuickActionsView")).click();
    await page.click('button:has-text("Revert to original")');
    await page.waitForFunction(
      (component) => document.querySelectorAll(`[data-vendo-inclient-mount="${component}"]`).length === 0,
      FORK_QUICKACTIONS,
      { timeout: 30_000 },
    );
    const pill = await remixPill("QuickActionsView");
    await pill.click();
    await (await managePill("QuickActionsView")).waitFor({ timeout: 60_000 });
    await closePopover();

    const queue = await (await page.request.get(`${BASE}/api/vendo/apps/review-queue`)).json();
    const entry = queue.find((candidate) => candidate.slot === "QuickActionsView");
    const NOTE = "Keep the Maple icon tint — resubmit with brand colors.";
    const reject = await page.request.post(`${BASE}/api/vendo/apps/${entry.appId}/reject-review`, {
      data: { note: NOTE },
    });
    if (!reject.ok()) fail("c1", `reject-review answered ${reject.status()}`);
    else log(`rejected ${entry.appId} with a note through the wire seam`);

    await page.reload();
    await page.waitForSelector("text=Total balance", { timeout: 30_000 });
    const status = await popoverStatus("QuickActionsView");
    const line = await status.innerText();
    const stillOriginal = (await page.locator('button:has-text("Move money")').count()) > 0;
    const mounted = (await jailCount(FORK_QUICKACTIONS)) + (await nativeCount(FORK_QUICKACTIONS));
    await shot("c1-rejection-note-in-panel");
    await closePopover();
    if (line.includes(NOTE) && stillOriginal && mounted === 0) {
      pass("c1", `reviewer's note is in the panel (“${line}”); the original still renders`);
    } else {
      fail("c1", `note=${line.includes(NOTE)} originalStays=${stillOriginal} mounted=${mounted} (“${line}”)`);
    }
  }

  // ---- (d) dashboard placement: generate → pin → placements, no drift ---
  {
    // The home "Custom view" slot invites authoring; the suggestion chip
    // prefills the composer (never sends) — then a REAL generation runs.
    await page.click('text=Show my spending by category');
    const composer = page.locator('textarea[aria-label="Message"]');
    await composer.waitFor({ timeout: 15_000 });
    await page.click('button[aria-label="Send"]');
    log("generation prompt sent; waiting for the app build…");
    const pin = page.locator('button:has-text("Pin to dashboard")').first();
    await pin.waitFor({ timeout: 300_000 });
    await shot("d1-generated-app-in-panel");
    await pin.click();
    log("pinned; waiting for the ghost to land in the home-hero slot…");
    await page.waitForTimeout(4_000);
    await page.keyboard.press("Escape");

    // Placement (not pin) written on the app row — read back over the wire.
    const apps = await (await page.request.get(`${BASE}/api/vendo/apps`)).json();
    await writeFile(path.join(DIR, "d2-apps-after-pin.json"), JSON.stringify(apps, null, 2));
    const placed = apps.find((app) => app.placements?.includes("home-hero"));
    const fabricatedPin = placed?.pins?.some((p) => p.slot === "home-hero") ?? false;
    const drift = await page.locator('text=Remixed component out of date').count();
    const invalidated = await page.locator('text=In-client approval invalidated').count();
    await page.waitForTimeout(2_000);
    await shot("d2-placed-in-home-hero-slot");
    if (placed && !fabricatedPin && drift === 0 && invalidated === 0) {
      pass("d", `placement written (app ${placed.id} → placements ${JSON.stringify(placed.placements)}, no fabricated pin); no drift warning anywhere`);
    } else {
      fail("d", `placed=${Boolean(placed)} fabricatedPin=${fabricatedPin} driftNotices=${drift + invalidated}`);
    }
  }
} catch (error) {
  fail("run", `unhandled: ${error?.message ?? error}`);
  await shot("zz-failure-state").catch(() => {});
} finally {
  await writeFile(path.join(DIR, "console.log.txt"), consoleLog.join("\n"));
  await writeFile(path.join(DIR, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  console.log("\n==== VERDICTS ====");
  for (const { step, verdict, note } of results) console.log(`${verdict === "PASS" ? "PASS" : "FAIL"}  ${step} — ${note}`);
  process.exitCode = results.some((r) => r.verdict === "FAIL") ? 1 : 0;
}
