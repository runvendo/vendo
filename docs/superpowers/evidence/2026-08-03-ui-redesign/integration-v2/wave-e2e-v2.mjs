/**
 * The WAVE E2E, RE-CAPTURED after the three post-check rounds (integration v2).
 *
 * Behavior changed materially since `../integration/wave.gif`: the thread's error
 * banner lost its Retry (ruling 16/18), the stage hint's one-shot ledger moved
 * into the split (H9), the activity row and the consent ladder were rewritten
 * (C2/C5/H6/H14), the center grew keyboard and focus contracts (H10/H12/H17/H18),
 * and app tiles boot only when scrolled to (H16). So the run is redone.
 *
 *   PORT=3230 node docs/superpowers/evidence/2026-08-03-ui-redesign/integration-v2/wave-e2e-v2.mjs
 *
 * CAPTURED AGAINST A PRODUCTION BUILD (`next build && next start`), not `next dev`.
 * Round A proved a dev-served surface shows the DEVELOPER half — dev-mode rails
 * print raw wire text by design (C2's `developmentMode()` gate, M36's dev-only
 * exception detail), so a dev capture would photograph the opposite of the claim.
 * No `nextjs-portal` hack is needed here: a production build ships no dev badge.
 *
 * The one non-live segment is the FAULT PATH, and it is faulted at the NETWORK
 * layer, not scripted in the UI: Playwright aborts the real `POST …/threads`
 * stream, so the surface under test is the shipped one reacting to a real dead
 * stream. Noted per-segment in the README.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { videoToGif } from "../../../../../scripts/capture-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = here;
const PORT = process.env.PORT ?? "3230";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/maple`;
const requireFromUi = createRequire(resolve(here, "../../../../../packages/ui/package.json"));
const { chromium } = requireFromUi("@playwright/test");

mkdirSync(OUT, { recursive: true });

const log = (...parts) => console.log("[wave2]", ...parts);
let shot = 0;
const still = async (page, name) => {
  shot += 1;
  const path = join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  log("still", path);
};

/** Poll a DOM predicate; false on timeout instead of throwing, so one soft beat
 *  never loses the whole recording. */
async function until(page, label, fn, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    if (Date.now() > deadline) {
      log("TIMEOUT waiting for", label);
      return false;
    }
    await page.waitForTimeout(400);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1_320, height: 860 },
  deviceScaleFactor: 2,
  recordVideo: { dir: join(OUT, ".video"), size: { width: 1_320, height: 860 } },
});
const page = await context.newPage();
// §8's "exactly one thing moves during a build" cannot be sampled by polling
// from the driver: a fast build opens and closes the window between two 400ms
// polls (it did on one take). This sampler runs in the page on every frame, so
// the measurement is continuous and cannot miss the window — it records the
// FIRST sample it sees plus the union of everything that ever looped while a
// build was in flight.
await context.addInitScript(() => {
  const seen = { first: null, union: [], samples: 0 };
  window.__vendoBuildCalm = seen;
  const looping = () => [...document.querySelectorAll(".vendo-root *")].filter(node => {
    const style = getComputedStyle(node);
    return style.animationName !== "none" && style.animationName !== ""
      && style.animationIterationCount !== "1";
  }).map(node => (typeof node.className === "string" ? node.className : String(node.className)));
  const tick = () => {
    if (document.querySelector('[data-state="building"]')) {
      const now = looping();
      seen.samples += 1;
      if (seen.first === null) seen.first = now;
      for (const name of now) if (!seen.union.includes(name)) seen.union.push(name);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
page.on("console", message => {
  if (message.type() === "error") log("page error:", message.text().slice(0, 200));
});

const facts = { productionBuild: true, port: PORT };
try {
  // ---- 0. the surface really is a production build ------------------------
  // A dev-served Next app answers with `x-nextjs-*` dev headers and paints
  // <nextjs-portal>. Assert their absence rather than claiming production.
  const landing = await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  facts.serverHeaders = {
    xPoweredBy: landing?.headers()["x-powered-by"] ?? null,
    devOverlay: await page.evaluate(() => document.querySelector("nextjs-portal") !== null),
  };
  log("server:", JSON.stringify(facts.serverHeaders));

  // ---- 1. cold start: real Maple login ------------------------------------
  log("login");
  await page.fill('input[name="email"]', process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com");
  await page.fill('input[name="password"]', process.env.MAPLE_DEMO_PASSWORD ?? "maple-demo");
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.endsWith("/login"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await still(page, "maple-home-cold");

  // ---- 2. the first ask: LIVE generation ----------------------------------
  log("open the panel");
  const launcher = page.locator("button.fl-launcher");
  await launcher.click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();
  await still(page, "panel-open");

  const ASK = "Where did my money go this month? Build me a spending breakdown I can keep";
  log("ask:", ASK);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(ASK);
  await box.press("Enter");

  facts.beats = await until(page, "a beat in the transcript",
    () => document.querySelectorAll(".fl-beat").length > 0, 90_000);
  if (facts.beats) {
    facts.beatsWorking = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    log("beats:", JSON.stringify(facts.beatsWorking));
    await still(page, "beats-working");
  }

  // §8 build calm — while a build runs, ONE element may be moving. Read off the
  // in-page rAF sampler, which cannot miss the window.
  facts.buildCalm = await until(page, "a build to be sampled",
    () => (window.__vendoBuildCalm?.samples ?? 0) > 0, 180_000);
  if (facts.buildCalm) {
    facts.buildCalmSamples = await page.evaluate(() => window.__vendoBuildCalm);
    facts.beatsDuringBuild = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    log("build-calm sampler:", JSON.stringify(facts.buildCalmSamples));
    log("beats during build:", JSON.stringify(facts.beatsDuringBuild));
    await still(page, "build-one-moving-thing");
  }

  facts.card = await until(page, "the app card",
    () => document.querySelector("[data-vendo-app-embed], .fl-appcard") !== null, 300_000);
  facts.staged = await page.evaluate(() =>
    document.querySelector('[data-vendo-expanded], .fl-split-stage') !== null);
  log("card:", facts.card, "staged:", facts.staged);
  if (facts.card) await still(page, "app-card-landed");

  // H9 — if the hint staged it, Back-to-chat is FINAL: the ledger lives in the
  // split now, so a collapse can never re-run the hint into a re-open.
  if (facts.staged) {
    const collapse = page.getByRole("button", { name: "Collapse workspace" });
    if (await collapse.count() > 0) {
      await collapse.click();
      await page.waitForTimeout(1_500);
      facts.h9BackToChatFinal = await page.evaluate(() =>
        document.querySelector("[data-vendo-expanded]") === null);
      log("H9 back-to-chat final:", facts.h9BackToChatFinal);
      await still(page, "h9-back-to-chat-final");
    }
  }

  facts.summary = await until(page, "the settled summary row",
    () => document.querySelector(".fl-beatsummary") !== null, 180_000);
  if (facts.summary) {
    facts.summaryText = await page.evaluate(() =>
      document.querySelector(".fl-beatsummary")?.textContent?.trim() ?? "");
    facts.beatsAtSettle = await page.evaluate(() =>
      [...document.querySelectorAll(".fl-beat")].map(node => node.textContent?.trim()));
    facts.stillBuildingAtSettle = await page.evaluate(() => ({
      hairlines: document.querySelectorAll(".fl-boot-hairline").length,
      buildingBars: document.querySelectorAll('[data-state="building"]').length,
    }));
    log("summary:", facts.summaryText);
    log("beats at settle:", JSON.stringify(facts.beatsAtSettle));
    log("still building at settle:", JSON.stringify(facts.stillBuildingAtSettle));
    await still(page, "turn-folded");
    await page.locator(".fl-beatsummary").first().click();
    await still(page, "turn-reopened");
    await page.locator(".fl-beatsummary").first().click();
  }

  // ---- 3. close the panel mid-second-ask (§2 G1, §13) --------------------
  log("second ask, then close mid-run");
  await box.fill("Now list my three biggest merchants this month and what I spent at each");
  await box.press("Enter");
  await until(page, "the second turn to start working",
    () => document.querySelector(".fl-beat, .fl-ribbon") !== null, 90_000);
  await page.getByRole("button", { name: "Close Vendo" }).click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor({ state: "hidden" });
  await still(page, "panel-closed-mid-ask");

  facts.pillProgress = await until(page, "the pill's live ring",
    () => document.querySelector(".fl-launcher-ring") !== null, 90_000);
  if (facts.pillProgress) {
    facts.pillLabel = await page.evaluate(() =>
      document.querySelector(".fl-launcher-beat")?.textContent?.trim() ?? "");
    log("pill narrates:", facts.pillLabel);
    await still(page, "pill-narrates");
  }

  facts.toast = await until(page, "the completion toast",
    () => document.querySelector(".fl-launcher-toast") !== null, 300_000);
  if (facts.toast) {
    facts.toastHead = await page.evaluate(() =>
      document.querySelector(".fl-launcher-toast-head")?.textContent?.trim() ?? "");
    log("toast:", facts.toastHead);
    await still(page, "completion-toast");
    await page.locator(".fl-launcher-toast").getByRole("button", { name: "View" }).click();
    await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();
    await still(page, "reopened-record");
  } else {
    await launcher.click();
    await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor();
  }

  // ---- 4. a FAILED turn: ✕ + prose, and NO Retry in the thread -----------
  // Ruling 16/18 — §15 governs the conversation, and the retry path there is the
  // agent's own prose plus the shipped Regenerate turn action. The failure is
  // real (the stream is aborted at the network layer); the SURFACE is the
  // shipped one, in production mode.
  log("fault path: kill the stream");
  await page.route("**/api/vendo/threads", async route => {
    if (route.request().method() === "POST") return route.abort("failed");
    return route.continue();
  });
  await box.fill("Summarize my spending for the year");
  await box.press("Enter");
  facts.turnFailed = await until(page, "the thread's failure prose",
    () => (document.querySelector(".fl-error")?.textContent ?? "").includes("didn"), 90_000);
  if (facts.turnFailed) {
    facts.failureCopy = await page.evaluate(() =>
      document.querySelector(".fl-error")?.textContent?.trim() ?? "");
    facts.failureAffordances = await page.evaluate(() => {
      const list = document.querySelector(".fl-msglist");
      const names = [...(list?.querySelectorAll("button") ?? [])]
        .map(node => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim());
      return {
        retryButtonsInThread: names.filter(name => /^try again$|^retry$/i.test(name)).length,
        regenerate: names.some(name => /regenerate/i.test(name)),
        errorBannerButtons: document.querySelectorAll(".fl-error button").length,
        // The ✕ marks, by the classes that actually exist: `.fl-beat-error` is a
        // failed step, `.fl-beat-x` its danger-coloured glyph, `.fl-beat-ic` the
        // glyph shared with a refused step. (The first pass of this driver looked
        // for `.fl-beat--failed`, which exists nowhere — a blind probe of exactly
        // the kind ruling 17a is about, and it reported 0 for the wrong reason.)
        crossGlyphs: document.querySelectorAll(".fl-beat-ic").length,
        errorBeats: document.querySelectorAll(".fl-beat.fl-beat-error").length,
        buildFailed: document.querySelectorAll("[data-vendo-build-failed]").length,
      };
    });
    log("failure copy:", facts.failureCopy);
    log("failure affordances:", JSON.stringify(facts.failureAffordances));
    await still(page, "thread-failure-no-retry");
  }
  await page.unroute("**/api/vendo/threads");

  // ---- 5. a LIVE money approval: pending → Approve → settled (§16) -------
  log("live approval");
  await box.fill("Send $47.50 to Acme Utilities from my checking account for the July water bill");
  await box.press("Enter");
  facts.approvalCard = await until(page, "the approval card",
    () => document.querySelector(".fl-cardshell.fl-approval") !== null, 240_000);
  if (facts.approvalCard) {
    const readCard = () => page.evaluate(() => {
      const card = document.querySelector(".fl-cardshell.fl-approval");
      return {
        eyebrow: card?.querySelector(".fl-card-eyebrow")?.textContent?.trim() ?? "",
        title: card?.querySelector(".fl-card-title")?.textContent?.trim() ?? "",
        // H6 / ruling 14: the plain-words line, from the shared consent ladder.
        line: card?.querySelector(".fl-approval-consequence-line, .fl-card-line")?.textContent?.trim() ?? "",
        rows: [...(card?.querySelectorAll(".fl-card-field") ?? [])].map(row => [
          row.querySelector("dt")?.textContent?.trim(),
          row.querySelector("dd")?.textContent?.trim(),
        ]),
        // §16 law 3: no model-instruction descriptor sentence reaches the reader.
        text: card?.textContent ?? "",
      };
    });
    facts.approval = await readCard();
    facts.approvalLeaks = {
      integerCents: facts.approval.text.includes("integer cents"),
      rawSlug: /host_[a-z_]+/.test(facts.approval.text),
    };
    log("approval:", JSON.stringify({ ...facts.approval, text: undefined }));
    log("leaks:", JSON.stringify(facts.approvalLeaks));
    await still(page, "approval-pending");

    const approve = page.locator(".fl-cardshell.fl-approval").getByRole("button", { name: /^Approve/ }).first();
    if (await approve.count() > 0) {
      await approve.click();
      facts.morphToast = await until(page, "the morph toast",
        () => document.querySelector(".fl-morph-card") !== null, 8_000);
      if (facts.morphToast) await still(page, "approval-morphing");
      facts.approvalSettled = await until(page, "the ask to clear and the turn to resume", () => {
        const askGone = document.querySelector(".fl-cardshell.fl-approval") === null;
        const resumed = /sent|transferred|moved|done/i.test(document.querySelector(".fl-msglist")?.textContent ?? "");
        return askGone && resumed;
      }, 180_000);
      facts.approvalOutcome = await page.evaluate(() => {
        const turns = [...document.querySelectorAll(".fl-turn-assistant, .fl-msg-assistant")];
        return turns.at(-1)?.textContent?.trim().slice(0, 220) ?? "";
      });
      log("settled:", facts.approvalSettled, "| outcome:", facts.approvalOutcome);
      await still(page, "approval-settled");
    }
  }

  // A second money ask, LEFT PENDING: §4's numbered badge and the center's
  // Needs-you section exist only while an ask is actually waiting.
  log("leave one ask pending");
  await box.fill("Move $200 from my checking account to savings.");
  await box.press("Enter");
  facts.secondAskPending = await until(page, "a second pending ask",
    () => document.querySelector(".fl-cardshell.fl-approval") !== null, 240_000);
  // §15's ✕ vocabulary, DETERMINISTICALLY: refuse an ask. A denied step is a
  // settled outcome carrying the same ✕ glyph as a failed one (muted rather than
  // danger-coloured — build-beat.tsx:449-452 renders one path for both), it stays
  // in the record, and the agent then says in its own prose that nothing
  // happened. A genuinely failed BUILD is not summonable on demand (v1 caught one
  // from the honesty gate on 2 of 3 takes) and host-tool faults are server-side,
  // so this is the reproducible route to the same law.
  const deny = page.locator(".fl-cardshell.fl-approval").getByRole("button", { name: /^Deny$/ }).first();
  if (await deny.count() > 0) {
    await deny.click();
    facts.denied = await until(page, "the refused step to settle in the record",
      () => document.querySelector(".fl-beat.fl-beat-done .fl-beat-ic") !== null
        || /declined/i.test(document.querySelector(".fl-msglist")?.textContent ?? ""), 120_000);
    facts.refusal = await page.evaluate(() => {
      const beats = [...document.querySelectorAll(".fl-beat")];
      return {
        // The ✕ glyph, by the classes that actually exist.
        crossGlyphs: document.querySelectorAll(".fl-beat-ic").length,
        errorBeats: document.querySelectorAll(".fl-beat.fl-beat-error").length,
        dangerCrosses: document.querySelectorAll(".fl-beat-ic.fl-beat-x").length,
        beats: beats.map(node => node.textContent?.trim()),
        // §15 — the agent's own words are the failure surface, and there is no
        // component to poke beyond the shipped Regenerate.
        retryButtonsInThread: [...(document.querySelector(".fl-msglist")?.querySelectorAll("button") ?? [])]
          .map(n => (n.getAttribute("aria-label") ?? n.textContent ?? "").trim())
          .filter(name => /^try again$|^retry$/i.test(name)).length,
        prose: (() => {
          const turns = [...document.querySelectorAll(".fl-turn-assistant, .fl-msg-assistant")];
          return turns.at(-1)?.textContent?.trim().slice(0, 240) ?? "";
        })(),
      };
    });
    log("refusal:", JSON.stringify(facts.refusal));
    await still(page, "denied-step-cross-and-prose");
  }

  // Leave a THIRD ask pending so the badge and the center's needs-you have
  // something to count.
  await box.fill("Move $75 from checking to savings for my travel fund.");
  await box.press("Enter");
  facts.thirdAskPending = await until(page, "a third pending ask",
    () => document.querySelector(".fl-cardshell.fl-approval") !== null, 240_000);
  // The IN-THREAD card for the ask that stays pending — the other half of H6's
  // card-vs-row comparison, which happens on the center page below.
  facts.secondAskCard = await page.evaluate(() => {
    const card = document.querySelector(".fl-cardshell.fl-approval");
    return {
      title: card?.querySelector(".fl-card-title")?.textContent?.trim() ?? "",
      line: card?.querySelector(".fl-approval-consequence-line, .fl-card-line")?.textContent?.trim() ?? "",
    };
  });
  log("second ask card:", JSON.stringify(facts.secondAskCard));
  await still(page, "second-ask-pending");


  await page.getByRole("button", { name: "Close Vendo" }).click();
  await page.getByRole("dialog", { name: "Vendo assistant" }).waitFor({ state: "hidden" });
  // §4's numbered badge reads the SHARED approvals feed at the launcher's own
  // cadence, so it appears a poll cycle after the panel closes — v1 hit the same
  // artifact and had to re-verify. Wait for it instead of photographing the gap.
  facts.badgeAppeared = await until(page, "the launcher's numbered badge",
    () => (document.querySelector(".fl-launcher-badge")?.textContent ?? "").trim() !== "", 60_000);
  facts.launcherBadge = await page.evaluate(() =>
    document.querySelector(".fl-launcher-badge")?.textContent?.trim() ?? "");
  log("launcher badge:", facts.launcherBadge, "(appeared:", facts.badgeAppeared, ")");
  await still(page, "launcher-badge");

  // ---- 6. the center walk: home / Apps / Automations / needs-you ---------
  log("center walk");
  await page.goto(`${BASE}/vendo/workspace`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  facts.center = await until(page, "the center rail",
    () => document.querySelector(".fl-center, .fl-rail-group, .fl-rail-row") !== null, 90_000);
  await still(page, "center-home");
  facts.centerRail = await page.evaluate(() => ({
    brandRow: document.querySelector(".fl-rail-brand") !== null,
    userRow: document.querySelector(".fl-rail-user") !== null,
    doors: [...document.querySelectorAll(".fl-rail-row")].map(node => node.textContent?.trim()),
    // H10 — a tablist always has exactly one keyboard stop, and the ONE panel
    // every tab points at carries a name.
    tabStops: [...document.querySelectorAll('[role="tab"]')].filter(node => node.tabIndex === 0).length,
    panelIds: [...new Set([...document.querySelectorAll('[role="tab"]')]
      .map(node => node.getAttribute("aria-controls")))],
    panelNamed: (() => {
      const panel = document.querySelector('[role="tabpanel"]');
      if (!panel) return null;
      const by = panel.getAttribute("aria-labelledby");
      return panel.getAttribute("aria-label")
        ?? (by ? document.getElementById(by)?.textContent?.trim() ?? null : null);
    })(),
    // H12 — exactly one main landmark on the page.
    mainLandmarks: document.querySelectorAll("main, [role=main]").length,
    needsYou: document.querySelector(".fl-rail-need") !== null,
  }));
  log("rail:", JSON.stringify(facts.centerRail));

  // H6 / ruling 14 — the SAME plain-words ladder on the card AND its queue row.
  // The waiting strip is mounted by the center's chat workspace (not the
  // overlay), so the comparison happens here, against the ask left pending above.
  const strip = page.locator(".fl-waiting-strip > summary");
  if (await strip.count() > 0) {
    await strip.first().click();
    await page.waitForTimeout(700);
    facts.queueRow = await page.evaluate(() => {
      const row = document.querySelector(".fl-waiting-strip .fl-cardshell");
      return {
        title: row?.querySelector(".fl-card-title")?.textContent?.trim() ?? "",
        line: row?.querySelector(".fl-card-line")?.textContent?.trim() ?? "",
        // §16 law 3 again, on the row this time.
        integerCents: (row?.textContent ?? "").includes("integer cents"),
        rawSlug: /host_[a-z_]+/.test(row?.textContent ?? ""),
      };
    });
    log("queue row:", JSON.stringify(facts.queueRow));
    await still(page, "h6-card-and-row-one-ladder");
    await strip.first().click();
  }

  // H18 — arrows MOVE focus, they do not activate. Walk the rail and prove the
  // selected door did not change under the keyboard.
  const firstTab = page.locator('[role="tab"]').first();
  await firstTab.focus();
  const before = await page.evaluate(() =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "");
  for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "End", "Home"]) await page.keyboard.press(key);
  facts.h18 = {
    selectedBefore: before,
    selectedAfter: await page.evaluate(() =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ""),
    focused: await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""),
  };
  log("H18:", JSON.stringify(facts.h18));
  await still(page, "h18-keyboard-walk");

  for (const door of ["Apps", "Automations"]) {
    const row = page.getByRole("tab", { name: door, exact: true }).first();
    if (await row.count() > 0) {
      await row.click();
      await page.waitForTimeout(1_200);
      if (door === "Apps") {
        // H11 — a tile's live preview is INERT: nothing inside it takes focus.
        // H16 — a tile below the fold booted nothing.
        facts.tiles = await page.evaluate(() => {
          const views = [...document.querySelectorAll(".fl-tile-view")];
          return {
            tiles: views.length,
            inert: views.filter(node => node.hasAttribute("inert")).length,
            ariaHidden: views.filter(node => node.getAttribute("aria-hidden") === "true").length,
            skeletonsBelowFold: [...document.querySelectorAll(".fl-tile-skel")].length,
          };
        });
        log("tiles:", JSON.stringify(facts.tiles));
      }
      await still(page, `center-${door.toLowerCase()}`);
    } else {
      log("no", door, "door found");
    }
  }
  if (facts.centerRail.needsYou) {
    await page.locator(".fl-rail-need").first().click();
    await page.waitForTimeout(900);
    facts.needsYouText = await page.evaluate(() =>
      document.querySelector(".fl-rail-need")?.textContent?.trim() ?? "");
    log("needs-you:", facts.needsYouText);
    await still(page, "center-needs-you");
  }

  // H17 — a center navigation carries focus with it.
  facts.h17FocusAfterNav = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName ?? null,
      role: active?.getAttribute("role") ?? null,
      label: (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim().slice(0, 60),
      isBody: active === document.body,
    };
  });
  log("H17 focus after nav:", JSON.stringify(facts.h17FocusAfterNav));

  facts.ok = true;
} catch (reason) {
  facts.ok = false;
  facts.failure = reason instanceof Error ? reason.message : String(reason);
  log("FAILED:", facts.failure);
  await still(page, "failure-state").catch(() => undefined);
} finally {
  await context.close();
  await browser.close();
}

const { gif } = await videoToGif(join(OUT, ".video"), join(OUT, "wave-v2.gif"), { fps: 10, width: 1_000 });
log("gif:", gif);
console.log("FACTS " + JSON.stringify(facts, null, 2));
