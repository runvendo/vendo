import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";

/**
 * `demo:research` — evidence-gathering for the creator agent, not automated
 * extraction: per-URL viewport + full-page screenshots, page title, meta
 * theme-color, favicon, and a computed-style sample of the obvious brand
 * carriers (body/header/nav/buttons/links), aggregated into a deduped
 * palette. The creator agent does the judging; there is deliberately no
 * color clustering, CSS parsing, or theme generation here.
 */

export interface DemoResearchArgs {
  /** Template-derived app directory that receives RESEARCH/; relative paths anchor at the repo root. */
  app: string;
  /** Prospect pages to capture, in order. */
  urls: string[];
}

const valueOptions = new Set(["--app", "--url"]);

function requireHttpUrl(value: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") {
    throw new Error(`--url must be an http(s) URL (received ${value})`);
  }
  return value;
}

export function parseDemoResearchArgs(argv: string[]): DemoResearchArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  let app: string | undefined;
  const urls: string[] = [];
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (!option?.startsWith("--")) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = normalizedArgv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (option === "--app") app = value;
    else urls.push(requireHttpUrl(value));
    index += 1;
  }
  if (app === undefined) throw new Error("--app is required");
  if (urls.length === 0) throw new Error("--url is required at least once (repeat it for extra pages)");
  return { app, urls };
}

/** One sampled element's computed brand-carrying styles. */
export interface StyleSample {
  /** What was sampled, e.g. "body", "header", "button[3]", "a[0]". */
  target: string;
  color: string;
  backgroundColor: string;
  fontFamily: string;
  borderRadius: string;
}

export interface ResearchPalette {
  colors: string[];
  fontFamilies: string[];
}

const emptyColorValues = new Set(["", "transparent", "rgba(0, 0, 0, 0)"]);

/** Dedupes the sampled colors and font families in first-seen order,
 * dropping fully transparent/empty values — evidence, not a theme. */
export function aggregatePalette(samples: readonly StyleSample[]): ResearchPalette {
  const colors: string[] = [];
  const fontFamilies: string[] = [];
  for (const entry of samples) {
    for (const color of [entry.color, entry.backgroundColor]) {
      if (!emptyColorValues.has(color) && !colors.includes(color)) colors.push(color);
    }
    if (entry.fontFamily !== "" && !fontFamilies.includes(entry.fontFamily)) {
      fontFamilies.push(entry.fontFamily);
    }
  }
  return { colors, fontFamilies };
}

const botChallengeMarkers = ["just a moment", "access denied"];

/** Bot walls (Cloudflare, Akamai) serve a challenge page whose screenshot is
 * junk; detect the obvious titles so the creator agent knows. */
export function isBotChallengeTitle(title: string): boolean {
  const normalized = title.toLowerCase();
  return botChallengeMarkers.some((marker) => normalized.includes(marker));
}

/** Ordered, filesystem-safe screenshot stem: "page-<n>-<host-and-path>". */
export function pageFileStem(url: string, index: number): string {
  const parsed = new URL(url);
  const slug = `${parsed.hostname}${parsed.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `page-${index + 1}-${slug}`;
}

export interface ResearchPageCapture {
  url: string;
  title: string;
  themeColor: string | null;
  favicon: string | null;
  botChallenge: boolean;
  /** Filenames relative to RESEARCH/. */
  screenshots: { viewport: string; fullPage: string };
  samples: StyleSample[];
}

/** A page that failed to load records its error and the run continues. */
export interface ResearchPageFailure {
  url: string;
  error: string;
}

export type ResearchPageEntry = ResearchPageCapture | ResearchPageFailure;

export interface ResearchReport {
  capturedAt: string;
  urls: string[];
  pages: ResearchPageEntry[];
  palette: ResearchPalette;
}

export function buildResearchReport(options: {
  urls: string[];
  pages: ResearchPageEntry[];
  capturedAt: string;
}): ResearchReport {
  const samples = options.pages.flatMap((page) => ("error" in page ? [] : page.samples));
  return {
    capturedAt: options.capturedAt,
    urls: options.urls,
    pages: options.pages,
    palette: aggregatePalette(samples),
  };
}

/** A realistic desktop UA — headless Chromium's default advertises
 * "HeadlessChrome", which trips even soft bot heuristics. */
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Runs inside the page; must stay self-contained (serialized by Playwright). */
function collectBrandEvidenceInPage(): {
  title: string;
  themeColor: string | null;
  favicon: string | null;
  samples: StyleSample[];
} {
  const samples: StyleSample[] = [];
  const sampleElement = (target: string, element: Element | null): void => {
    if (element === null) return;
    const style = window.getComputedStyle(element);
    samples.push({
      target,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontFamily: style.fontFamily,
      borderRadius: style.borderRadius,
    });
  };
  sampleElement("body", document.body);
  sampleElement("header", document.querySelector("header"));
  sampleElement("nav", document.querySelector("nav"));
  document.querySelectorAll('button, [role="button"]').forEach((element, index) => {
    if (index < 10) sampleElement(`button[${index}]`, element);
  });
  document.querySelectorAll("a[href]").forEach((element, index) => {
    if (index < 10) sampleElement(`a[${index}]`, element);
  });
  const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return {
    title: document.title,
    themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
    favicon: favicon?.href ?? null,
    samples,
  };
}

async function capturePage(options: {
  context: BrowserContext;
  url: string;
  index: number;
  researchDir: string;
}): Promise<ResearchPageCapture> {
  const page = await options.context.newPage();
  await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  // Network-quiet-ish settle: best effort — long-polling/analytics keep some
  // sites from ever reaching networkidle, and DOM content is already in.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const stem = pageFileStem(options.url, options.index);
  const screenshots = { viewport: `${stem}-viewport.png`, fullPage: `${stem}-full.png` };
  await page.screenshot({ path: path.join(options.researchDir, screenshots.viewport) });
  await page.screenshot({ path: path.join(options.researchDir, screenshots.fullPage), fullPage: true });
  const evidence = await page.evaluate(collectBrandEvidenceInPage);
  return {
    url: options.url,
    ...evidence,
    botChallenge: isBotChallengeTitle(evidence.title),
    screenshots,
  };
}

export interface DemoResearchResult {
  researchDir: string;
  reportPath: string;
  report: ResearchReport;
}

export async function runDemoResearch(args: DemoResearchArgs, options: { repoRoot: string }): Promise<DemoResearchResult> {
  const appDir = path.resolve(options.repoRoot, args.app);
  if (!existsSync(path.join(appDir, "demo.config.json"))) {
    throw new Error(`--app must point at a template-derived demo app, but there is no demo.config.json in "${appDir}"`);
  }
  const researchDir = path.join(appDir, "RESEARCH");
  await mkdir(researchDir, { recursive: true });

  const pages: ResearchPageEntry[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    for (const [index, url] of args.urls.entries()) {
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
        pages.push(await capturePage({ context, url, index, researchDir }));
      } catch (error) {
        pages.push({ url, error: error instanceof Error ? error.message : String(error) });
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const report = buildResearchReport({
    urls: args.urls,
    pages,
    capturedAt: new Date().toISOString(),
  });
  const reportPath = path.join(researchDir, "research.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  // Partial failure is recorded evidence; total failure is a failed run.
  if (pages.every((page) => "error" in page)) {
    throw new Error(`demo:research failed for every URL:\n${pages
      .map((page) => `  ${page.url}: ${"error" in page ? page.error : ""}`)
      .join("\n")}`);
  }
  return { researchDir, reportPath, report };
}
