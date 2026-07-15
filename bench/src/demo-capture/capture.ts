import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { BrowserCaptureArgs } from "./cli-args.js";
import { bootDemoHost, demoHosts, type ConcreteDemoHost, type DemoHostDefinition } from "./hosts.js";
import {
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
 * email prefilled and a single password field. Signs in when the wall is
 * present and waits to land back on the capture route; no-op when a session
 * cookie already exists. */
async function signInIfNeeded(page: Page, host: DemoHostDefinition, timeoutMs: number): Promise<void> {
  const loginForm = page.locator('form[action="/login"]');
  if (await loginForm.count() === 0) return;
  const password = process.env[host.demoPasswordEnv] ?? host.demoPasswordFallback;
  await loginForm.locator('input[name="password"]').fill(password);
  await loginForm.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: timeoutMs });
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
  const message = composer.getByRole("textbox", { name: "Message" });
  await message.waitFor({ state: "visible", timeout: 30_000 });
  await message.fill(prompt);
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  return { assistantTurns };
}

async function waitForTurn(options: {
  page: Page;
  previousAssistantTurns: number;
  timeoutMs: number;
  requireView: boolean;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    await approveIfPresent(options.page);
    const alert = options.page.locator(".fl-error:visible, .fl-att-error:visible").first();
    if (await alert.count() > 0 && await alert.isVisible().catch(() => false)) {
      throw new Error(`Vendo capture surfaced an error: ${(await alert.textContent())?.trim() ?? "unknown error"}`);
    }
    const turns = await options.page.locator('article[data-role="assistant"]').count();
    const textarea = options.page.locator('form[aria-label="Message composer"]')
      .getByRole("textbox", { name: "Message" });
    const idle = await textarea.isEnabled().catch(() => false);
    let hasView = true;
    if (options.requireView) {
      const lastAssistant = options.page.locator('article[data-role="assistant"]').last();
      hasView = turns > options.previousAssistantTurns
        && await lastAssistant.locator("[data-vendo-node-id]").count() > 0;
    }
    if (turns > options.previousAssistantTurns && idle && hasView) return;
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
      await waitForTurn({
        page,
        previousAssistantTurns: edit.assistantTurns,
        timeoutMs: options.args.timeoutMs,
        requireView: true,
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
