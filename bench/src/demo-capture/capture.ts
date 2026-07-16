import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { DemoBeat as DemoConfigBeat } from "demo-template/demo-config";
import type { BrowserCaptureArgs, ConfigCaptureArgs } from "./cli-args.js";
import {
  bootDemoHost,
  configDemoHost,
  demoHosts,
  type CaptureHostDefinition,
  type ConcreteDemoHost,
  type DemoHostDefinition,
} from "./hosts.js";
import {
  demoBeatCompletionPhase,
  installCaptureOverlayInPage,
  remixCompletionPhase,
  type CaptureOverlaySnapshot,
} from "./overlay.js";
import { combineGifsSideBySide, videoToGif } from "./video.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultOutputRoot = path.join(repoRoot, "bench", "demo-capture", "output");

const prompts: Record<BrowserCaptureArgs["beat"], Record<ConcreteDemoHost, string>> = {
  "streaming-first-paint": {
    maple: "Generate an interactive Maple spending dashboard for my recent transactions. Show a monthly total, category breakdown, and the unusual $87 charge in a polished generated UI view.",
    cadence: "Generate an interactive Cadence client-work dashboard. Show filing deadlines, missing documents, and client status in a polished generated UI view.",
  },
  "host-component": {
    maple: "Generate a compact Maple balance-trend card and compose the registered host component MapleSparkline with realistic 30-day balance data. Use the host component from the catalog, not generated chart code.",
    cadence: "Generate a compact Cadence client-progress view using the most appropriate registered Cadence host components from the catalog.",
  },
  "remix-edit": {
    maple: "Generate one interactive Maple cash-flow dashboard as a single generated component with income, spending, and a 30-day trend.",
    cadence: "Generate one interactive Cadence workload dashboard as a single generated component with deadlines, document progress, and client risk.",
  },
};

const editPrompts: Record<ConcreteDemoHost, string> = {
  maple: "Remix that view without rebuilding it from scratch: make the spending breakdown denser, add a 30-day comparison, and preserve the existing view continuously while editing.",
  cadence: "Remix that view without rebuilding it from scratch: add a compact overdue-documents lane and preserve the existing view continuously while editing.",
};

export interface HostCaptureResult {
  host: ConcreteDemoHost;
  gif: string;
  rawVideo: string;
  overlay: CaptureOverlaySnapshot;
}

export interface BrowserCaptureResult {
  beat: BrowserCaptureArgs["beat"];
  runDir: string;
  gif: string;
  captures: HostCaptureResult[];
}

function safeRunId(value: string | undefined): string {
  const fallback = new Date().toISOString().replace(/[:.]/g, "-");
  return (value ?? fallback).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function hostList(host: BrowserCaptureArgs["host"]): ConcreteDemoHost[] {
  return host === "both" ? ["maple", "cadence"] : [host];
}

/** Both demo hosts sit behind a real login wall (ENG-260): unauthenticated
 * visits land on a plain, scriptable /login form with the primary demo user's
 * email prefilled and a single password field. Both post the form to /login
 * server-side (Maple via Auth.js, Cadence via a Supabase password grant) and
 * 303 back to the capture route. Signs in when the wall is present and waits
 * to land back off /login; no-op when a session cookie already exists. */
async function signInIfNeeded(page: Page, host: CaptureHostDefinition, timeoutMs: number): Promise<void> {
  const loginForm = page.locator('form[action="/login"]');
  if (await loginForm.count() === 0) return;
  const password = (host.demoPasswordEnv === undefined ? undefined : process.env[host.demoPasswordEnv])
    ?? host.demoPasswordFallback;
  if (password === undefined) {
    throw new Error(`${host.label} presented a login wall, but its host definition carries no demo password`);
  }
  await loginForm.locator('input[name="password"]').fill(password);
  await loginForm.locator('button[type="submit"]').click();
  // Resolve as soon as the post-login navigation commits off /login. The
  // default waitUntil "load" blocks on every subresource of the destination
  // route, which on a cold Turbopack first-compile (Cadence /assistant) can
  // outlast the timeout even though auth already succeeded; the caller reloads
  // the route explicitly right after, so a committed URL change is enough.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: timeoutMs, waitUntil: "commit" });
  await page.waitForLoadState("domcontentloaded");
}

async function clearThread(page: Page, threadId: string): Promise<void> {
  const status = await page.evaluate(async (id) => {
    const response = await fetch(`/api/vendo/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    return response.status;
  }, threadId);
  if (status !== 200 && status !== 404) {
    throw new Error(`Could not reset ${threadId}: HTTP ${status}`);
  }
}

async function approveIfPresent(page: Page): Promise<boolean> {
  const approve = page.getByRole("button", { name: "Approve", exact: true }).first();
  if (await approve.count() === 0 || !await approve.isVisible().catch(() => false)) return false;
  if (await approve.isEnabled().catch(() => false)) {
    await approve.click();
    return true;
  }
  return false;
}

async function sendPrompt(page: Page, prompt: string): Promise<{ assistantTurns: number }> {
  const assistantTurns = await page.locator('article[data-role="assistant"]').count();
  const composer = page.locator('form[aria-label="Message composer"]');
  const userTurns = await page.locator('article[data-role="user"]').count();
  const message = composer.getByRole("textbox", { name: "Message" });
  await message.waitFor({ state: "visible", timeout: 30_000 });
  await message.fill(prompt);
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  // The prompt must land in the thread as a user turn; otherwise the composer
  // swallowed the submit and every later wait would time out on nothing.
  await page.locator('article[data-role="user"]').nth(userTurns).waitFor({ state: "attached", timeout: 30_000 });
  return { assistantTurns };
}

/** Caps refusal (429/410 `vendoDemo` body) on a template-derived demo host.
 * The route only exists there; on maple/cadence the fetch resolves to a 404
 * page and the parse yields null, so this never misfires for them. */
async function demoCapsRefusal(page: Page): Promise<{ limit: string } | null> {
  return await page.evaluate(async () => {
    try {
      const response = await fetch("/demo-status");
      const body = (await response.json()) as { vendoDemo?: { limit: string } | null };
      return body.vendoDemo ?? null;
    } catch {
      return null;
    }
  }).catch(() => null);
}

/** Exported for the unit test of the approval-settle sequence. */
export async function waitForTurn(options: {
  page: Page;
  previousAssistantTurns: number;
  timeoutMs: number;
  requireView: boolean;
  /** A Vendo remix revises the existing generated view IN PLACE and adds no
   * new assistant article, so a new-turn check never fires. In this mode the
   * turn is complete once a full generate→settle cycle is observed (the
   * composer goes busy and returns idle) with a generated view still on
   * screen. When omitted, the original new-turn condition is used, unchanged. */
  inPlaceRevision?: boolean;
}): Promise<{ approvals: number }> {
  const deadline = Date.now() + options.timeoutMs;
  let sawBusy = false;
  let approvals = 0;
  // Granting an approval auto-resumes the parked run, so the turn must not be
  // declared settled until that resumed run has visibly gone busy and come
  // back idle with no approval still pending — otherwise a fast poll could
  // settle while the just-approved tool is still executing.
  let resettleAfterApproval = false;
  let sawBusySinceApproval = false;
  while (Date.now() < deadline) {
    if (await approveIfPresent(options.page)) {
      approvals += 1;
      resettleAfterApproval = true;
      sawBusySinceApproval = false;
      await options.page.waitForTimeout(300);
      continue;
    }
    const alert = options.page.locator(".fl-error:visible, .fl-att-error:visible").first();
    if (await alert.count() > 0 && await alert.isVisible().catch(() => false)) {
      const refusal = await demoCapsRefusal(options.page);
      if (refusal !== null) {
        throw new Error(`demo caps exhausted (${refusal.limit}) — the capture burned the demo's own turns; a capture-side condition, not a demo failure`);
      }
      throw new Error(`Vendo capture surfaced an error: ${(await alert.textContent())?.trim() ?? "unknown error"}`);
    }
    const textarea = options.page.locator('form[aria-label="Message composer"]')
      .getByRole("textbox", { name: "Message" });
    const idle = await textarea.isEnabled().catch(() => false);
    const busy = !idle
      || await options.page.locator('.fl-msglist[aria-busy="true"], .fl-thinking, .fl-act-pulse').count() > 0;
    if (busy) {
      sawBusy = true;
      sawBusySinceApproval = true;
    }
    if (resettleAfterApproval) {
      const approvalPending = await options.page
        .locator(".fl-tool-detail", { hasText: "approval-requested" }).count() > 0;
      if (approvalPending || busy || !sawBusySinceApproval) {
        await options.page.waitForTimeout(300);
        continue;
      }
    }
    if (options.inPlaceRevision) {
      // "Generating" spans the composer being disabled and the busy/pulse
      // indicators. A remix's generation runs for seconds, so the busy state is
      // always observed by the 300ms poll before it settles.
      const hasView = await options.page.locator("[data-vendo-node-id]").count() > 0;
      if (sawBusy && !busy && hasView) return { approvals };
    } else {
      const turns = await options.page.locator('article[data-role="assistant"]').count();
      let hasView = true;
      if (options.requireView) {
        const lastAssistant = options.page.locator('article[data-role="assistant"]').last();
        hasView = turns > options.previousAssistantTurns
          && await lastAssistant.locator("[data-vendo-node-id]").count() > 0;
      }
      if (turns > options.previousAssistantTurns && idle && hasView) return { approvals };
    }
    await options.page.waitForTimeout(300);
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for the generated Vendo turn`);
}

async function captureHost(options: {
  args: BrowserCaptureArgs;
  host: DemoHostDefinition;
  runDir: string;
}): Promise<HostCaptureResult> {
  const hostDir = path.join(options.runDir, options.host.id);
  await mkdir(hostDir, { recursive: true });
  const running = options.args.boot
    ? await bootDemoHost({
      host: options.host,
      port: options.args.port,
      repoRoot,
      logFile: path.join(hostDir, "server.log"),
      timeoutMs: options.args.timeoutMs,
    })
    : {
      baseUrl: options.args.url ?? `http://127.0.0.1:${options.args.port}`,
      stop: async () => undefined,
    };

  const rawDir = path.join(hostDir, "video");
  await mkdir(rawDir, { recursive: true });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let rawVideo = "";
  let overlay: CaptureOverlaySnapshot = { elapsedMs: 0, blankSamples: 0, continuityWatching: false };
  try {
    browser = await chromium.launch({ headless: !options.args.headed });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: rawDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    await page.goto(new URL(options.host.route, running.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: options.args.timeoutMs });
    await signInIfNeeded(page, options.host, options.args.timeoutMs);
    await clearThread(page, options.host.threadId);
    await page.reload({ waitUntil: "domcontentloaded", timeout: options.args.timeoutMs });
    await page.getByRole("textbox", { name: "Message" }).waitFor({ state: "visible", timeout: options.args.timeoutMs });
    await page.evaluate(installCaptureOverlayInPage, {
      label: options.host.label,
      beat: options.args.beat.replaceAll("-", " ").toUpperCase(),
      continuity: options.args.beat === "remix-edit",
    });

    const first = await sendPrompt(page, options.args.prompt ?? prompts[options.args.beat][options.host.id]);
    await waitForTurn({
      page,
      previousAssistantTurns: first.assistantTurns,
      timeoutMs: options.args.timeoutMs,
      requireView: options.args.beat !== "host-component",
    });

    if (options.args.beat === "remix-edit") {
      await page.evaluate(() => {
        window.__vendoDemoCapture?.setPhase("REMIX REQUESTED · VIEW MUST STAY VISIBLE");
        window.__vendoDemoCapture?.watchContinuity();
      });
      const edit = await sendPrompt(page, options.args.editPrompt ?? editPrompts[options.host.id]);
      // A remix revises the existing view in place (no new assistant article),
      // so detect completion by the generate→settle cycle, not a new turn.
      await waitForTurn({
        page,
        previousAssistantTurns: edit.assistantTurns,
        timeoutMs: options.args.timeoutMs,
        requireView: true,
        inPlaceRevision: true,
      });
    }

    await page.waitForTimeout(2_000);
    overlay = await page.evaluate(() => window.__vendoDemoCapture?.snapshot())
      ?? { elapsedMs: 0, blankSamples: 0, continuityWatching: false };
    if (options.args.beat === "remix-edit") {
      await page.evaluate(
        (phase) => window.__vendoDemoCapture?.setPhase(phase),
        remixCompletionPhase(overlay.blankSamples),
      );
      await page.waitForTimeout(500);
      overlay = await page.evaluate(() => window.__vendoDemoCapture?.snapshot()) ?? overlay;
    }
    const video = page.video();
    await context.close();
    context = undefined;
    rawVideo = await video?.path() ?? "";
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await running.stop();
  }
  if (rawVideo === "") throw new Error(`Playwright did not produce a video for ${options.host.label}`);
  const gif = path.join(options.runDir, `${options.args.beat}-${options.host.id}.gif`);
  await videoToGif(rawVideo, gif);
  await writeFile(path.join(hostDir, "capture.json"), `${JSON.stringify({
    beat: options.args.beat,
    host: options.host.id,
    prompt: options.args.prompt ?? prompts[options.args.beat][options.host.id],
    ...(options.args.beat === "remix-edit" ? { editPrompt: options.args.editPrompt ?? editPrompts[options.host.id] } : {}),
    overlay,
    gif,
    rawVideo,
  }, null, 2)}\n`);
  return { host: options.host.id, gif, rawVideo, overlay };
}

export interface DemoBeatStep {
  key: string;
  prompt: string;
  overlayBeat: string;
  /** The beat's declared verification contract (demo.config `expectsView` /
   * `expectsApproval`, defaulting to false): unmet expectations fail the
   * capture instead of settling green. */
  expectsView: boolean;
  expectsApproval: boolean;
}

/** demo-beats plays the config's beats sequentially in one continuous
 * recording (the thread is never reset between beats — one demo story); each
 * step reinstalls the stopwatch overlay under its own label so every beat
 * gets its own submit-anchored marks. */
export function demoBeatPlan(beats: readonly DemoConfigBeat[]): DemoBeatStep[] {
  return beats.map((beat, index) => ({
    key: beat.key,
    prompt: beat.prompt,
    overlayBeat: `BEAT ${index + 1}/${beats.length} · ${beat.key.replaceAll("-", " ").toUpperCase()}`,
    expectsView: beat.expectsView === true,
    expectsApproval: beat.expectsApproval === true,
  }));
}

export interface ConfigBeatCapture {
  key: string;
  prompt: string;
  /** Consent cards auto-approved while this beat's turn ran. */
  approvals: number;
  overlay: CaptureOverlaySnapshot;
}

export interface ConfigCaptureResult {
  beat: "demo-beats";
  runDir: string;
  gif: string;
  rawVideo: string;
  host: string;
  beats: ConfigBeatCapture[];
}

/** The generic capture: boot a template-derived app from its own directory
 * (see {@link configDemoHost}) and run its demo.config beats back to back in
 * one recording. Completion per beat is a settled new assistant turn, not a
 * generated view — a config beat may be an action (its consent card is
 * auto-approved and counted) rather than a UI generation. */
export async function runConfigCapture(args: ConfigCaptureArgs): Promise<ConfigCaptureResult> {
  // The pnpm-filtered script runs with cwd bench/, while the documented
  // invocation passes repo-root-relative paths (apps/demo-template) — so a
  // relative --host-config is anchored at the repo root, never the cwd.
  const appDir = path.resolve(repoRoot, args.hostConfig);
  const { host, config } = await configDemoHost(appDir);
  const outputRoot = path.resolve(args.outputDir ?? defaultOutputRoot);
  const runDir = path.join(outputRoot, safeRunId(args.runId));
  const hostDir = path.join(runDir, host.id);
  const rawDir = path.join(hostDir, "video");
  // All directories before the server boots: a mkdir failure must not leak it.
  await mkdir(rawDir, { recursive: true });
  // A demo-beats run consumes several of the demo's own capped turns. A local
  // capture starts from fresh counters — the file only exists where the app
  // process runs, so deployed demos are untouched.
  await rm(path.join(appDir, ".vendo", "data", "demo-caps.json"), { force: true });
  const running = args.boot
    ? await bootDemoHost({
      host,
      port: args.port,
      repoRoot,
      logFile: path.join(hostDir, "server.log"),
      timeoutMs: args.timeoutMs,
    })
    : {
      baseUrl: args.url ?? `http://127.0.0.1:${args.port}`,
      stop: async () => undefined,
    };

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let rawVideo = "";
  const beats: ConfigBeatCapture[] = [];
  try {
    browser = await chromium.launch({ headless: !args.headed });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: rawDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    await page.goto(new URL(host.route, running.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await signInIfNeeded(page, host, args.timeoutMs);
    await clearThread(page, host.threadId);
    await page.reload({ waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await page.getByRole("textbox", { name: "Message" }).waitFor({ state: "visible", timeout: args.timeoutMs });

    for (const step of demoBeatPlan(config.beats)) {
      // The caps guard swaps the panel for the limit/expired card; surface
      // that as its own condition instead of a composer timeout.
      const unavailable = page.locator('[aria-label="Demo unavailable"]');
      if (await unavailable.count() > 0 && await unavailable.isVisible().catch(() => false)) {
        throw new Error(`demo caps exhausted before beat "${step.key}" — a capture-side condition, not a demo failure`);
      }
      await page.evaluate(installCaptureOverlayInPage, { label: host.label, beat: step.overlayBeat });
      const sent = await sendPrompt(page, step.prompt);
      const { approvals } = await waitForTurn({
        page,
        previousAssistantTurns: sent.assistantTurns,
        timeoutMs: args.timeoutMs,
        requireView: false,
      });
      await page.waitForTimeout(2_000);
      const overlay = await page.evaluate(() => window.__vendoDemoCapture?.snapshot());
      if (!overlay) {
        throw new Error(`the capture overlay disappeared during beat "${step.key}" — the page reloaded or the stopwatch failed to install`);
      }
      if (step.expectsApproval && approvals === 0) {
        throw new Error(`beat "${step.key}" expected a consent approval, but no approval card appeared`);
      }
      if (step.expectsView && overlay.firstPaintMs === undefined) {
        throw new Error(`beat "${step.key}" expected a generated view, but no first paint was marked`);
      }
      await page.evaluate(
        (phase) => window.__vendoDemoCapture?.setPhase(phase),
        demoBeatCompletionPhase(approvals),
      );
      await page.waitForTimeout(500);
      beats.push({ key: step.key, prompt: step.prompt, approvals, overlay });
    }

    const video = page.video();
    await context.close();
    context = undefined;
    rawVideo = await video?.path() ?? "";
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await running.stop();
  }
  if (rawVideo === "") throw new Error(`Playwright did not produce a video for ${host.label}`);
  const gif = path.join(runDir, `demo-beats-${host.id}.gif`);
  await videoToGif(rawVideo, gif);
  await writeFile(path.join(hostDir, "capture.json"), `${JSON.stringify({
    beat: args.beat,
    host: host.id,
    prospect: config.prospect,
    appDir,
    beats,
    gif,
    rawVideo,
  }, null, 2)}\n`);
  return { beat: args.beat, runDir, gif, rawVideo, host: host.id, beats };
}

export async function runBrowserCapture(args: BrowserCaptureArgs): Promise<BrowserCaptureResult> {
  const outputRoot = path.resolve(args.outputDir ?? defaultOutputRoot);
  const runDir = path.join(outputRoot, safeRunId(args.runId));
  await mkdir(runDir, { recursive: true });
  const captures: HostCaptureResult[] = [];
  for (const host of hostList(args.host)) {
    captures.push(await captureHost({ args, host: demoHosts[host], runDir }));
  }
  const gif = captures.length === 1
    ? captures[0]!.gif
    : path.join(runDir, `${args.beat}.gif`);
  if (captures.length > 1) await combineGifsSideBySide(captures.map((capture) => capture.gif), gif);
  return { beat: args.beat, runDir, gif, captures };
}
