import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  layer3TargetUrl,
  openVendoSurface,
  prepareLayer3Page,
  sendPrompt,
  waitForIdle,
  type E2eNavigationOptions,
  type E2ePage,
} from "./layers/e2e.js";

const safeIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const nativeScreenSchema = z.object({
  id: z.string().regex(safeIdPattern),
  label: z.string().min(1),
  path: z.string().startsWith("/").refine((value) => !value.startsWith("//"), "path must be host-relative"),
  waitFor: z.string().min(1).optional(),
}).strict();
const galleryPromptSchema = z.object({
  id: z.string().regex(safeIdPattern),
  label: z.string().min(1),
  prompt: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
const galleryConfigSchema = z.object({
  version: z.literal(1),
  nativeScreens: z.array(nativeScreenSchema).min(1).max(2),
  prompts: z.array(galleryPromptSchema).min(1),
}).strict();

export interface GalleryNativeScreen {
  id: string;
  label: string;
  path: string;
  waitFor?: string;
}

export interface GalleryPrompt {
  id: string;
  label: string;
  prompt: string;
  timeoutMs?: number;
}

export interface GalleryConfig {
  version: 1;
  nativeScreens: GalleryNativeScreen[];
  prompts: GalleryPrompt[];
}

export interface GalleryTimings {
  marksMs: {
    promptSubmitted: 0;
    generationToolCalled: number;
    firstGeneratedPixel: number;
    settledUsable: number;
  };
  durationsMs: {
    promptToFirstPaint: number;
    promptToUsable: number;
    generationToFirstPaint: number;
    generationToUsable: number;
  };
  bars: {
    firstPaintUnder1s: boolean;
    usableUnder10s: boolean;
  };
}

export interface GalleryPromptCapture {
  firstPaintPath: string;
  settledPath: string;
  animationPath: string;
  animationFormat: "gif" | "webm";
  animationNote: string;
  timings: GalleryTimings;
}

export interface GalleryNativeCaptureInput {
  repoName: string;
  readinessUrl: string;
  screen: GalleryNativeScreen;
  outputPath: string;
}

export interface GalleryPromptCaptureInput {
  repoName: string;
  readinessUrl: string;
  prompt: GalleryPrompt;
  artifactDir: string;
}

export interface GalleryCaptureDriver {
  captureNativeScreen(input: GalleryNativeCaptureInput): Promise<void>;
  capturePrompt(input: GalleryPromptCaptureInput): Promise<GalleryPromptCapture>;
  close(): Promise<void>;
}

export interface GalleryNativeResult {
  id: string;
  label: string;
  path: string;
}

export interface GalleryPromptResult extends GalleryPromptCapture {
  id: string;
  label: string;
  prompt: string;
}

export interface GalleryRepoResult {
  repoName: string;
  nativeScreens: GalleryNativeResult[];
  prompts: GalleryPromptResult[];
  error?: string;
}

export interface CaptureGalleryRepoOptions {
  repoName: string;
  readinessUrl: string;
  expectationsRoot: string;
  runRoot: string;
  driver?: GalleryCaptureDriver;
}

export interface WriteGalleryHtmlOptions {
  runId: string;
  runRoot: string;
  generatedAt: string;
  repos: GalleryRepoResult[];
}

export interface GalleryP95 {
  sampleCount: number;
  promptToFirstPaintMs: number;
  promptToUsableMs: number;
  generationToFirstPaintMs: number;
  generationToUsableMs: number;
  firstPaintUnder1s: boolean;
  usableUnder10s: boolean;
}

export type FfmpegRunner = (webmPath: string, gifPath: string) => Promise<void>;

export interface GenerationApprovalOptions {
  timeoutMs: number;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultPromptTimeoutMs = 240_000;
const nativeScreenTimeoutMs = 60_000;
const firstPaintSelector = "[data-vendo-node-id]";
const generationToolSelector = '.fl-tool:has-text("vendo_apps_create"), .fl-tool:has-text("vendo_apps_edit")';
const generationApprovalSelector = '.fl-approval:has-text("vendo_apps_create") button:has-text("Approve"), .fl-approval:has-text("vendo_apps_edit") button:has-text("Approve")';
const viewport = { width: 1_440, height: 960 };

export function galleryNavigationOptions(timeoutMs: number): E2eNavigationOptions {
  return {
    waitUntil: "domcontentloaded",
    timeout: Math.min(timeoutMs, 60_000),
  };
}

export function parseGalleryConfig(value: unknown): GalleryConfig {
  return galleryConfigSchema.parse(value) as GalleryConfig;
}

export async function loadGalleryConfig(expectationsRoot: string, repoName: string): Promise<GalleryConfig> {
  const configPath = path.join(expectationsRoot, repoName, "gallery.json");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No gallery.json config found for ${repoName}.`);
    }
    throw error;
  }
  return parseGalleryConfig(JSON.parse(source) as unknown);
}

export async function discoverConfiguredGalleryRepoNames(expectationsRoot: string): Promise<string[]> {
  const entries = await readdir(expectationsRoot, { withFileTypes: true });
  const configured: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeIdPattern.test(entry.name)) continue;
    try {
      await readFile(path.join(expectationsRoot, entry.name, "gallery.json"));
      configured.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return configured.sort();
}

export async function captureGalleryRepo(options: CaptureGalleryRepoOptions): Promise<GalleryRepoResult> {
  const config = await loadGalleryConfig(options.expectationsRoot, options.repoName);
  const repoRoot = path.join(options.runRoot, options.repoName);
  const nativeRoot = path.join(repoRoot, "native");
  const promptsRoot = path.join(repoRoot, "prompts");
  await mkdir(nativeRoot, { recursive: true });
  await mkdir(promptsRoot, { recursive: true });
  const driver = options.driver ?? await createPlaywrightGalleryDriver();

  const nativeScreens: GalleryNativeResult[] = [];
  const prompts: GalleryPromptResult[] = [];
  try {
    // Native captures deliberately precede every generated capture. They are
    // the fidelity baseline and must not inherit state from a generated turn.
    for (const screen of config.nativeScreens) {
      const outputPath = path.join(nativeRoot, `${screen.id}.png`);
      await driver.captureNativeScreen({
        repoName: options.repoName,
        readinessUrl: options.readinessUrl,
        screen,
        outputPath,
      });
      nativeScreens.push({ id: screen.id, label: screen.label, path: outputPath });
    }

    for (const prompt of config.prompts) {
      const artifactDir = path.join(promptsRoot, prompt.id);
      await mkdir(artifactDir, { recursive: true });
      const capture = await driver.capturePrompt({
        repoName: options.repoName,
        readinessUrl: options.readinessUrl,
        prompt,
        artifactDir,
      });
      await writeFile(
        path.join(artifactDir, "timings.json"),
        `${JSON.stringify({
          ...capture.timings,
          animation: {
            format: capture.animationFormat,
            file: path.basename(capture.animationPath),
            note: capture.animationNote,
          },
        }, null, 2)}\n`,
      );
      prompts.push({
        id: prompt.id,
        label: prompt.label,
        prompt: prompt.prompt,
        ...capture,
      });
    }
  } finally {
    await driver.close();
  }

  const result: GalleryRepoResult = { repoName: options.repoName, nativeScreens, prompts };
  await writeFile(path.join(repoRoot, "report.json"), `${JSON.stringify(serializableRepoResult(result, repoRoot), null, 2)}\n`);
  return result;
}

export async function createPlaywrightGalleryDriver(): Promise<GalleryCaptureDriver> {
  const playwright = await import("@playwright/test");
  const browser = await playwright.chromium.launch({ headless: true });

  return {
    async captureNativeScreen(input) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        const targetUrl = new URL(input.screen.path, input.readinessUrl).toString();
        await prepareLayer3Page(
          input.repoName,
          page as unknown as E2ePage,
          nativeScreenTimeoutMs,
          targetUrl,
          galleryNavigationOptions(nativeScreenTimeoutMs),
        );
        if (input.screen.waitFor) {
          await page.locator(input.screen.waitFor).first().waitFor({ state: "visible", timeout: nativeScreenTimeoutMs });
        }
        await page.waitForTimeout(750);
        await page.screenshot({ path: input.outputPath, fullPage: false });
      } finally {
        await context.close();
      }
    },

    async capturePrompt(input) {
      await mkdir(input.artifactDir, { recursive: true });
      const context = await browser.newContext({
        viewport,
        recordVideo: { dir: input.artifactDir, size: viewport },
      });
      const page = await context.newPage();
      const video = page.video();
      const timeoutMs = input.prompt.timeoutMs ?? defaultPromptTimeoutMs;
      const webmPath = path.join(input.artifactDir, "generation.webm");
      const firstPaintPath = path.join(input.artifactDir, "first-paint.png");
      const settledPath = path.join(input.artifactDir, "settled.png");
      let captureError: unknown;
      let timings: GalleryTimings | undefined;

      try {
        const targetUrl = layer3TargetUrl(
          input.readinessUrl,
          input.repoName,
          `gallery-${input.prompt.id}-${Date.now().toString(36)}`,
        );
        await prepareLayer3Page(
          input.repoName,
          page as unknown as E2ePage,
          Math.min(timeoutMs, 30_000),
          targetUrl,
          galleryNavigationOptions(timeoutMs),
        );
        await openVendoSurface(page as unknown as E2ePage, Math.min(timeoutMs, 30_000));
        const initialGeneratedNodes = await page.locator(firstPaintSelector).count();
        const initialGenerationTools = await page.locator(generationToolSelector).count();
        const startedAt = performance.now();
        await sendPrompt(page as unknown as E2ePage, input.prompt.prompt);
        let stopApprovalWatcher = false;
        const approvalWatcher = approveGenerationIfRequested(page as unknown as E2ePage, {
          timeoutMs,
          shouldStop: () => stopApprovalWatcher,
        });
        const [generationToolCalled, firstPaint] = await (async () => {
          try {
            return await Promise.all([
              page.locator(generationToolSelector).nth(initialGenerationTools).waitFor({
                state: "visible",
                timeout: timeoutMs,
              }).then(() => elapsedMs(startedAt)),
              page.locator(firstPaintSelector).nth(initialGeneratedNodes).waitFor({
                state: "visible",
                timeout: timeoutMs,
              }).then(() => elapsedMs(startedAt)),
            ]);
          } finally {
            stopApprovalWatcher = true;
            await approvalWatcher;
          }
        })();
        await page.screenshot({ path: firstPaintPath, fullPage: false });

        const remainingMs = Math.max(1_000, timeoutMs - firstPaint);
        await waitForIdle(page as unknown as E2ePage, remainingMs);
        const settledStartedAt = performance.now();
        while (
          await page.locator(firstPaintSelector).count() <= initialGeneratedNodes
          || await page.locator('.fl-msglist[aria-busy="true"], .fl-thinking, .fl-act-pulse').count() > 0
        ) {
          if (performance.now() - settledStartedAt > remainingMs) {
            throw new Error(`Timed out after ${remainingMs}ms waiting for a settled generated view.`);
          }
          await page.waitForTimeout(100);
        }
        // Require a short stable window after the busy signal clears so the
        // settled screenshot represents a usable view rather than one frame.
        await page.waitForTimeout(500);
        const usable = elapsedMs(startedAt);
        await page.screenshot({ path: settledPath, fullPage: false });
        timings = createGalleryTimings(generationToolCalled, firstPaint, usable);
      } catch (error) {
        captureError = error;
      } finally {
        await context.close();
        if (video) {
          try {
            await video.saveAs(webmPath);
          } catch (error) {
            if (!captureError) captureError = error;
          }
        }
      }

      if (captureError) throw captureError;
      if (!timings) throw new Error(`Gallery prompt ${input.prompt.id} did not produce timing marks.`);
      const animation = await convertVideoToGif(
        webmPath,
        path.join(input.artifactDir, "generation.gif"),
      );
      return {
        firstPaintPath,
        settledPath,
        ...animation,
        timings,
      };
    },

    async close() {
      await browser.close();
    },
  };
}

export async function approveGenerationIfRequested(
  page: E2ePage,
  options: GenerationApprovalOptions,
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const startedAt = performance.now();
  while (!options.shouldStop?.() && performance.now() - startedAt < options.timeoutMs) {
    const matches = page.locator(generationApprovalSelector);
    const approve = matches.first ? matches.first() : matches;
    try {
      if (await approve.count() > 0) {
        if (!approve.click) throw new Error("Gallery approval control is not clickable.");
        await approve.click();
        return true;
      }
    } catch (error) {
      if (options.shouldStop?.()) return false;
      throw error;
    }
    await sleep(100);
  }
  return false;
}

export function createGalleryTimings(
  generationToolCalledMs: number,
  firstPaintMs: number,
  usableMs: number,
): GalleryTimings {
  const generationToolCalled = Math.max(0, Math.round(generationToolCalledMs));
  const firstPaint = Math.max(generationToolCalled, Math.round(firstPaintMs));
  const usable = Math.max(firstPaint, Math.round(usableMs));
  return {
    marksMs: {
      promptSubmitted: 0,
      generationToolCalled,
      firstGeneratedPixel: firstPaint,
      settledUsable: usable,
    },
    durationsMs: {
      promptToFirstPaint: firstPaint,
      promptToUsable: usable,
      generationToFirstPaint: firstPaint - generationToolCalled,
      generationToUsable: usable - generationToolCalled,
    },
    bars: {
      firstPaintUnder1s: firstPaint - generationToolCalled < 1_000,
      usableUnder10s: usable - generationToolCalled < 10_000,
    },
  };
}

export async function convertVideoToGif(
  webmPath: string,
  gifPath: string,
  runner: FfmpegRunner = runFfmpeg,
): Promise<Pick<GalleryPromptCapture, "animationPath" | "animationFormat" | "animationNote">> {
  try {
    await runner(webmPath, gifPath);
    return {
      animationPath: gifPath,
      animationFormat: "gif",
      animationNote: "converted with ffmpeg",
    };
  } catch (error) {
    const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      animationPath: webmPath,
      animationFormat: "webm",
      animationNote: unavailable
        ? "ffmpeg unavailable; retained Playwright WebM"
        : `ffmpeg conversion failed (${errorMessage(error)}); retained Playwright WebM`,
    };
  }
}

async function runFfmpeg(webmPath: string, gifPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-i",
      webmPath,
      "-vf",
      "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
      gifPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}${stderr ? `: ${stderr.trim().slice(-1_000)}` : ""}`));
    });
  });
}

export async function writeGalleryHtml(options: WriteGalleryHtmlOptions): Promise<string> {
  await mkdir(options.runRoot, { recursive: true });
  const sections: string[] = [];
  for (const repo of options.repos) {
    sections.push(await renderRepoSection(repo));
  }
  const p95 = calculateGalleryP95(options.repos);
  const latencySummary = p95
    ? `<div class="bars"><span>Latency bars · ${p95.sampleCount} prompt sample${p95.sampleCount === 1 ? "" : "s"}</span>${summaryMetric("p95 generation tool call → first generated pixel", formatDuration(p95.generationToFirstPaintMs), "<1s", p95.firstPaintUnder1s)}${summaryMetric("p95 generation tool call → settled/usable", formatDuration(p95.generationToUsableMs), "<10s", p95.usableUnder10s)}${summaryMetric("p95 end-to-end prompt submit → first generated pixel", formatDuration(p95.promptToFirstPaintMs), "includes approval wait")}${summaryMetric("p95 end-to-end prompt submit → settled/usable", formatDuration(p95.promptToUsableMs), "includes approval wait")}</div>`
    : `<div class="bars"><span>Latency bars</span><strong>No successful prompt samples</strong></div>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vendo corpus gallery · ${escapeHtml(options.runId)}</title>
  <style>${galleryCss}</style>
</head>
<body>
  <header class="masthead">
    <p class="eyebrow">Vendo · corpus verification</p>
    <h1>Generation gallery</h1>
    <p>Run <code>${escapeHtml(options.runId)}</code> · ${escapeHtml(options.generatedAt)}</p>
    ${latencySummary}
  </header>
  <main>${sections.join("\n")}</main>
</body>
</html>\n`;
  const galleryPath = path.join(options.runRoot, "gallery.html");
  await writeFile(galleryPath, html);
  return galleryPath;
}

export function calculateGalleryP95(repos: readonly GalleryRepoResult[]): GalleryP95 | undefined {
  const prompts = repos.flatMap((repo) => repo.error ? [] : repo.prompts);
  if (prompts.length === 0) return undefined;
  const promptToFirstPaintMs = nearestRankP95(prompts.map((prompt) => prompt.timings.durationsMs.promptToFirstPaint));
  const promptToUsableMs = nearestRankP95(prompts.map((prompt) => prompt.timings.durationsMs.promptToUsable));
  const generationToFirstPaintMs = nearestRankP95(prompts.map((prompt) => prompt.timings.durationsMs.generationToFirstPaint));
  const generationToUsableMs = nearestRankP95(prompts.map((prompt) => prompt.timings.durationsMs.generationToUsable));
  return {
    sampleCount: prompts.length,
    promptToFirstPaintMs,
    promptToUsableMs,
    generationToFirstPaintMs,
    generationToUsableMs,
    firstPaintUnder1s: generationToFirstPaintMs < 1_000,
    usableUnder10s: generationToUsableMs < 10_000,
  };
}

function nearestRankP95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function renderRepoSection(repo: GalleryRepoResult): Promise<string> {
  if (repo.error) {
    return `<section class="repo"><div class="repo-heading"><p>Deep-tier host</p><h2>${escapeHtml(repo.repoName)}</h2></div><div class="error">${escapeHtml(repo.error)}</div></section>`;
  }
  const nativeCards: string[] = [];
  for (const screen of repo.nativeScreens) {
    nativeCards.push(`<figure><img src="${await dataUri(screen.path, "image/png")}" alt="${escapeHtml(screen.label)}"><figcaption>${escapeHtml(screen.label)}</figcaption></figure>`);
  }
  const promptCards: string[] = [];
  for (const prompt of repo.prompts) {
    const promptToFirstPaint = formatDuration(prompt.timings.durationsMs.promptToFirstPaint);
    const promptToUsable = formatDuration(prompt.timings.durationsMs.promptToUsable);
    const generationToFirstPaint = formatDuration(prompt.timings.durationsMs.generationToFirstPaint);
    const generationToUsable = formatDuration(prompt.timings.durationsMs.generationToUsable);
    promptCards.push(`<article class="prompt">
      <div class="prompt-heading"><div><p>Generated view</p><h3>${escapeHtml(prompt.label)}</h3></div><div class="metrics">
        ${metric("Generation tool call → first generated pixel (<1s)", generationToFirstPaint, prompt.timings.bars.firstPaintUnder1s)}
        ${metric("Generation tool call → settled/usable (<10s)", generationToUsable, prompt.timings.bars.usableUnder10s)}
        ${metric("End-to-end prompt submit → first generated pixel (includes approval wait)", promptToFirstPaint)}
        ${metric("End-to-end prompt submit → settled/usable (includes approval wait)", promptToUsable)}
      </div></div>
      <p class="prompt-copy">${escapeHtml(prompt.prompt)}</p>
      <div class="capture-grid">
        <figure><img src="${await dataUri(prompt.firstPaintPath, "image/png")}" alt="First generated paint"><figcaption>First generated paint · Generation tool call → first generated pixel ${generationToFirstPaint} · End-to-end prompt submit → first generated pixel ${promptToFirstPaint} (includes approval wait)</figcaption></figure>
        <figure><img src="${await dataUri(prompt.settledPath, "image/png")}" alt="Settled usable view"><figcaption>Settled / usable · Generation tool call → settled/usable ${generationToUsable} · End-to-end prompt submit → settled/usable ${promptToUsable} (includes approval wait)</figcaption></figure>
        ${await animationFigure(prompt)}
      </div>
    </article>`);
  }
  return `<section class="repo">
    <div class="repo-heading"><p>Deep-tier host</p><h2>${escapeHtml(repo.repoName)}</h2></div>
    <div class="comparison">
      <aside><div class="column-heading"><span>Fidelity baseline</span><h3>Host-native screens</h3></div>${nativeCards.join("\n")}</aside>
      <div class="generated"><div class="column-heading"><span>Vendo output</span><h3>Generated UI</h3></div>${promptCards.join("\n")}</div>
    </div>
  </section>`;
}

async function animationFigure(prompt: GalleryPromptResult): Promise<string> {
  const mime = prompt.animationFormat === "gif" ? "image/gif" : "video/webm";
  const source = await dataUri(prompt.animationPath, mime);
  const media = prompt.animationFormat === "gif"
    ? `<img src="${source}" alt="Full generation replay">`
    : `<video autoplay loop muted controls playsinline><source src="${source}" type="video/webm"></video>`;
  return `<figure>${media}<figcaption>Full generation replay · ${escapeHtml(prompt.animationNote)}</figcaption></figure>`;
}

function metric(label: string, value: string, pass?: boolean): string {
  const state = pass === undefined ? "neutral" : pass ? "pass" : "fail";
  return `<span class="metric ${state}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`;
}

function summaryMetric(label: string, value: string, target?: string, pass?: boolean): string {
  const state = pass === undefined ? "neutral" : pass ? "pass" : "fail";
  return `<strong class="summary-metric ${state}">${escapeHtml(label)} · ${escapeHtml(value)}${target ? ` <small>${pass === undefined ? "" : "target "}${escapeHtml(target)}</small>` : ""}</strong>`;
}

async function dataUri(filePath: string, mime: string): Promise<string> {
  const bytes = await readFile(filePath);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

function serializableRepoResult(result: GalleryRepoResult, repoRoot: string): unknown {
  return {
    ...result,
    nativeScreens: result.nativeScreens.map((screen) => ({
      ...screen,
      path: relativeArtifactPath(repoRoot, screen.path),
    })),
    prompts: result.prompts.map((prompt) => ({
      ...prompt,
      firstPaintPath: relativeArtifactPath(repoRoot, prompt.firstPaintPath),
      settledPath: relativeArtifactPath(repoRoot, prompt.settledPath),
      animationPath: relativeArtifactPath(repoRoot, prompt.animationPath),
    })),
  };
}

function relativeArtifactPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const galleryCss = `
:root{color-scheme:dark;--bg:#090b0f;--panel:#11151b;--panel2:#171c24;--line:#29313d;--text:#f2f4f7;--muted:#98a3b3;--accent:#8ff0c7;--bad:#ff9b93;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--text)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#163328 0,transparent 30rem),var(--bg)}img,video{display:block;width:100%;background:#fff;border-radius:12px}.masthead,main{width:min(1560px,calc(100% - 40px));margin:auto}.masthead{padding:72px 0 56px}.eyebrow,.repo-heading p,.prompt-heading p{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px}.masthead h1{font-size:clamp(48px,8vw,112px);letter-spacing:-.07em;line-height:.9;margin:0}.masthead>p:last-of-type{color:var(--muted)}code{color:var(--text)}.bars{display:flex;flex-wrap:wrap;gap:18px;align-items:center;border-top:1px solid var(--line);margin-top:36px;padding-top:20px;color:var(--muted)}.bars strong{color:var(--text)}.summary-metric{border-left:3px solid var(--line);padding-left:10px}.summary-metric small{color:var(--muted);font-weight:500}.summary-metric.pass{border-color:#2c785e;color:var(--accent)}.summary-metric.fail{border-color:#884640;color:var(--bad)}.repo{border-top:1px solid var(--line);padding:56px 0 80px}.repo-heading h2{font-size:44px;letter-spacing:-.04em;margin:0 0 32px;text-transform:capitalize}.comparison{display:grid;grid-template-columns:minmax(280px,.78fr) minmax(0,2.22fr);gap:24px}.comparison>aside,.generated{background:color-mix(in srgb,var(--panel) 90%,transparent);border:1px solid var(--line);border-radius:18px;padding:18px}.column-heading{padding:4px 4px 18px}.column-heading span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.12em}.column-heading h3{margin:5px 0 0;font-size:20px}figure{margin:0 0 18px}figcaption{color:var(--muted);font-size:12px;padding:9px 3px}.prompt{border-top:1px solid var(--line);padding:24px 0}.prompt:first-of-type{border-top:0;padding-top:0}.prompt-heading{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.prompt-heading h3{font-size:27px;letter-spacing:-.03em;margin:0}.prompt-copy{color:var(--muted);max-width:78ch;line-height:1.55}.metrics{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.metric{display:grid;gap:2px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-width:160px}.metric small{color:var(--muted)}.metric.pass{border-color:#2c785e}.metric.pass strong{color:var(--accent)}.metric.fail{border-color:#884640}.metric.fail strong{color:var(--bad)}.capture-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}.error{border:1px solid #884640;background:#2a1718;color:var(--bad);padding:20px;border-radius:12px}@media(max-width:1000px){.comparison{grid-template-columns:1fr}.capture-grid{grid-template-columns:1fr}.prompt-heading{display:block}.metrics{justify-content:flex-start;margin-top:16px}}@media(max-width:600px){.masthead,main{width:min(100% - 24px,1560px)}.bars{align-items:flex-start;flex-direction:column}.metrics{flex-direction:column}}
`;
