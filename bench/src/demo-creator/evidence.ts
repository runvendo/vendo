import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ContextDevError,
  createContextDevClient,
  domainFromUrl,
  type BrandLogo,
  type BrandRetrieveResult,
  type ContextDevClient,
  type FontsResult,
  type MarkdownResult,
  type StyleguideResult,
} from "./context-dev.js";
import { demoPaths, normalizeHex, type DemoPaths } from "./demo-folder.js";

/**
 * Stage 1 of `demo:pipeline` — evidence.
 *
 * Copies the operator's reference screenshots into the demo's RESEARCH/ folder
 * and asks context.dev the four questions that decide how the clone will look:
 * the brand's logo, the colours the site actually renders, the faces that carry
 * its type, and its own words. Every API call fails SOFT — the screenshots are
 * the reference material that matters, and a demo built from them with a
 * missing font answer still ships. The screenshots themselves are operator
 * input: a missing one is a hard error, because it is a typo, not weather.
 *
 * Output is one digest, RESEARCH/evidence.json, so the brief stage and
 * `demo:fix` read a file instead of re-paying for the API.
 */

export interface EvidenceArgs {
  slug: string;
  prospect: string;
  /** The prospect's site. Without it, three of the four calls cannot be keyed. */
  url?: string;
  /** Absolute paths to the operator's reference screenshots, in order. */
  screenshots: string[];
}

export interface EvidenceIo {
  demosRepo: string;
  client?: ContextDevClient;
  write?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface EvidenceScreenshot {
  /** RESEARCH-relative */
  file: string;
  /** The operator's own file NAME. Basename only: this digest is committed to
   * the host repo, and their local path is not ours to publish. */
  source: string;
}

export interface SoftFailure {
  call: string;
  reason: string;
}

export interface EvidenceResult {
  screenshots: EvidenceScreenshot[];
  /** demo-folder-relative, e.g. "brand/logo.svg" or "brand/logo.png" */
  logo?: { file: string; source: string };
  brand?: BrandRetrieveResult;
  styleguide?: StyleguideResult;
  fonts?: FontsResult;
  /** RESEARCH-relative markdown file */
  markdown?: { file: string; title?: string };
  /** Ordered brand palette: every hex the evidence actually contains. The brief
   * may ONLY copy from this. */
  palette: string[];
  soft: SoftFailure[];
  /** RESEARCH-relative raw response files */
  rawFiles: string[];
}

/** The one file stage 2 and `demo:fix` read instead of re-calling the API. */
export const evidenceFileName = "evidence.json";

/** RESEARCH-relative file the scraped site text lands in. */
const markdownFileName = "site.md";

/** A wordmark clones better than a favicon, and a logo drawn for a light page
 * survives being dropped onto one. Size breaks the remaining ties. */
export function pickLogo(logos: readonly BrandLogo[]): BrandLogo | undefined {
  const typeRank = (logo: BrandLogo): number => (logo.type === "logo" ? 2 : logo.type === undefined ? 1 : 0);
  const modeRank = (logo: BrandLogo): number => {
    if (logo.mode === "light" || logo.mode === "has_opaque_background") return 2;
    return logo.mode === undefined ? 1 : 0;
  };
  const area = (logo: BrandLogo): number =>
    logo.resolution === undefined ? 0 : logo.resolution.width * logo.resolution.height;
  return [...logos].sort(
    (a, b) => typeRank(b) - typeRank(a) || modeRank(b) - modeRank(a) || area(b) - area(a),
  )[0];
}

/** SVG scales into a header at any size, so it is worth detecting from the
 * bytes: brand.dev's CDN serves plenty of URLs whose extension lies. */
function isSvg(contentType: string, bytes: Buffer): boolean {
  const head = bytes.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  // The content-type alone is not enough: a CDN that answers an HTML error page
  // can still label it image/svg+xml. The bytes have to look like SVG.
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return true;
  return contentType.toLowerCase().includes("svg") && head.startsWith("<") && !head.startsWith("<!doctype html") && !head.startsWith("<html");
}

/** The magic bytes of every raster format brand.dev's CDN actually serves. */
const imageMagic: { label: string; matches: (bytes: Buffer) => boolean }[] = [
  { label: "png", matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { label: "jpeg", matches: (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { label: "gif", matches: (bytes) => bytes.subarray(0, 4).toString("ascii") === "GIF8" },
  { label: "webp", matches: (bytes) => bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" },
  { label: "ico", matches: (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00])) },
];

/**
 * Whether these bytes are an image AT ALL.
 *
 * The failure this exists for: a CDN answering **200** with an HTML "403
 * Forbidden" page. `response.ok` is true, so the page was written to
 * brand/logo.png, recorded in the digest as a SUCCESS, committed to the host
 * repo, and the fidelity judge then scored logo fidelity against a broken image
 * — a 2/10 that reads as "the clone is wrong" instead of "the download failed".
 */
export function looksLikeImage(contentType: string, bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  return isSvg(contentType, bytes) || imageMagic.some((format) => format.matches(bytes));
}

/**
 * The same HTML-with-200 class on the TEXT half of the evidence: context.dev
 * hands back whatever the page served, so a Cloudflare interstitial or an error
 * page arrives as "markdown" and becomes the site text the brand brief derives
 * the prospect's vocabulary and voice from.
 *
 * Returns why it is unusable, or undefined when it reads like real site text.
 */
export function scrapedTextProblem(markdown: string): string | undefined {
  const text = markdown.trim();
  // Deliberately a floor, not a quality bar: a real product page can be terse,
  // and this only has to catch "nothing came back".
  if (text.length < 16) return `the scrape returned ${text.length} characters of text — nothing the brief can read`;
  const head = text.slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "the scrape returned an HTML document rather than markdown — the site served a page context.dev could not read";
  }
  const interstitials = [
    "just a moment",
    "enable javascript and cookies",
    "attention required! | cloudflare",
    "checking your browser",
    "403 forbidden",
    "access denied",
    "you do not have permission",
    "are you a robot",
    "request blocked",
  ];
  const matched = interstitials.find((needle) => head.includes(needle));
  return matched === undefined ? undefined : `the scrape returned a block/error page ("${matched}"), not the prospect's site text`;
}

function failureReason(error: unknown): string {
  // ContextDevError's message already names the endpoint, status and the API's
  // own message, and no error in this path ever carries the key.
  return error instanceof Error ? error.message : String(error);
}

function errorEnvelope(error: unknown): unknown {
  if (error instanceof ContextDevError) {
    return {
      status: "error",
      http_status: error.status,
      endpoint: error.endpoint,
      ...(error.errorCode === undefined ? {} : { error_code: error.errorCode }),
      message: error.message,
    };
  }
  return { status: "error", message: failureReason(error) };
}

/** Drops the verbatim body before the result goes into the digest — it is
 * already on disk in its own RESEARCH/context-dev/ file. */
function withoutRaw<T extends { raw?: unknown }>(value: T): T {
  const { raw, ...rest } = value;
  void raw;
  return rest as T;
}

/**
 * Everything the evidence and judge stages own, removed before this run writes.
 *
 * These stages only ever created directories, so a re-run of the same slug wrote
 * over SOME files and inherited the rest. The dangerous survivor is
 * `brand/logo.svg`: if this run's logo call soft-fails, the previous run's logo
 * stays on disk, gets committed, and the fidelity judge scores brand fidelity
 * against another prospect's mark. Re-running one slug in one checkout is exactly
 * what the host fence's agent-window baseline enables, so this stopped being
 * theoretical.
 *
 * `RESEARCH/timings.json` is the ONE survivor: the stage runner has already
 * written THIS run's rows into it before evidence starts, and it is the run's own
 * record rather than inherited evidence.
 */
async function clearPreviousEvidence(paths: DemoPaths): Promise<void> {
  await rm(paths.brandDir, { recursive: true, force: true });
  const timingsName = path.basename(paths.timings);
  for (const entry of await readdir(paths.researchDir).catch(() => [])) {
    if (entry === timingsName) continue;
    await rm(path.join(paths.researchDir, entry), { recursive: true, force: true });
  }
}

export async function runEvidence(args: EvidenceArgs, io: EvidenceIo): Promise<EvidenceResult> {
  if (args.screenshots.length === 0) {
    throw new Error("evidence: at least one reference screenshot is required (--screenshots /abs/a.png,/abs/b.png)");
  }
  const write = io.write ?? ((): void => {});
  const paths = demoPaths(io.demosRepo, args.slug);
  await clearPreviousEvidence(paths);
  await mkdir(paths.contextDevDir, { recursive: true });
  await mkdir(paths.brandDir, { recursive: true });

  const screenshots: EvidenceScreenshot[] = [];
  for (const [index, source] of args.screenshots.entries()) {
    const name = path.basename(source);
    // Indexed so two files both named screenshot.png cannot overwrite each
    // other, and so the brief can cite them in the operator's order.
    const file = `${index + 1}-${name}`;
    try {
      await copyFile(source, path.join(paths.researchDir, file));
    } catch (error) {
      throw new Error(`evidence: cannot read the reference screenshot "${source}": ${failureReason(error)}`);
    }
    screenshots.push({ file, source: name });
  }
  write(`  screenshots: ${screenshots.length} copied into RESEARCH/`);

  const soft: SoftFailure[] = [];
  const rawFiles: string[] = [];
  const client = io.client ?? createContextDevClient(io.fetchImpl === undefined ? {} : { fetchImpl: io.fetchImpl });

  async function record(call: string, payload: unknown): Promise<void> {
    const file = path.join(paths.contextDevDir, `${call}.json`);
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
    rawFiles.push(path.relative(paths.researchDir, file));
  }

  async function attempt<T extends { raw?: unknown }>(call: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await run();
      await record(call, result.raw ?? result);
      return result;
    } catch (error) {
      const reason = failureReason(error);
      soft.push({ call, reason });
      await record(call, errorEnvelope(error));
      write(`  ${call}: failed soft — ${reason}`);
      return undefined;
    }
  }

  const url = args.url;
  const domain = url === undefined ? undefined : domainFromUrl(url);
  const noDomainReason =
    url === undefined
      ? "no --url given — this call is keyed on the prospect's site"
      : `--url does not resolve to a domain (${url}) — this call is keyed on the prospect's site`;

  const brand = await attempt("retrieve-brand", () =>
    domain === undefined ? client.retrieveBrand({ name: args.prospect }) : client.retrieveBrand({ domain }),
  );
  if (brand !== undefined) {
    write(`  retrieve-brand: ${brand.colors.length} colours, ${brand.logos.length} logos`);
  }

  let styleguide: StyleguideResult | undefined;
  let fonts: FontsResult | undefined;
  let markdown: MarkdownResult | undefined;
  if (url === undefined || domain === undefined) {
    for (const call of ["styleguide", "fonts", "scrape-markdown"]) {
      soft.push({ call, reason: noDomainReason });
      write(`  ${call}: skipped — ${noDomainReason}`);
    }
  } else {
    styleguide = await attempt("styleguide", () => client.styleguide({ domain }));
    if (styleguide !== undefined) {
      const headings = Object.keys(styleguide.typography?.headings ?? {}).length;
      write(`  styleguide: rendered accent/background/text + ${headings} heading styles`);
    }
    fonts = await attempt("fonts", () => client.fonts({ domain }));
    if (fonts !== undefined) {
      write(`  fonts: ${fonts.fonts.length} faces, ${Object.keys(fonts.fontLinks ?? {}).length} font links`);
    }
    // Main content only: nav/footer boilerplate crowds out the product words
    // the brief needs for vocabulary and voice.
    markdown = await attempt("scrape-markdown", () =>
      client.scrapeMarkdown({ url, useMainContentOnly: true }),
    );
    if (markdown !== undefined) {
      // A 200 that is not site text is a SOFT failure, never brief material.
      const problem = scrapedTextProblem(markdown.markdown);
      if (problem === undefined) {
        write(`  scrape-markdown: ${markdown.contentLength} bytes of site text`);
      } else {
        soft.push({ call: "scrape-markdown", reason: problem });
        write(`  scrape-markdown: failed soft — ${problem}`);
        markdown = undefined;
      }
    }
  }

  let markdownEntry: EvidenceResult["markdown"];
  if (markdown !== undefined) {
    await writeFile(path.join(paths.researchDir, markdownFileName), markdown.markdown);
    const title = markdown.metadata?.title;
    markdownEntry = { file: markdownFileName, ...(title === undefined ? {} : { title }) };
  }

  let logo: EvidenceResult["logo"];
  if (brand !== undefined) {
    const chosen = pickLogo(brand.logos);
    if (chosen === undefined) {
      const reason = `context.dev returned no logo for ${args.prospect}`;
      soft.push({ call: "logo", reason });
      write(`  logo: failed soft — ${reason}`);
    } else {
      try {
        const response = await (io.fetchImpl ?? fetch)(chosen.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${chosen.url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") ?? "";
        if (!looksLikeImage(contentType, bytes)) {
          // NOTHING is written: presence of brand/logo.png is what the brief and
          // the judge both read as "we have their logo".
          throw new Error(
            `${chosen.url} answered 200 but the ${bytes.length} bytes are not an image (content-type ${contentType || "absent"}, starts with ${JSON.stringify(bytes.subarray(0, 24).toString("utf8"))}) — a CDN error page, not a logo`,
          );
        }
        const svg = isSvg(contentType, bytes);
        await writeFile(svg ? paths.logoSvg : paths.logoPng, bytes);
        logo = { file: svg ? "brand/logo.svg" : "brand/logo.png", source: chosen.url };
        write(`  logo: ${logo.file}`);
      } catch (error) {
        const reason = failureReason(error);
        soft.push({ call: "logo", reason });
        write(`  logo: failed soft — ${reason}`);
      }
    }
  }

  const palette: string[] = [];
  const addHex = (value: string | undefined): void => {
    const hex = value === undefined ? undefined : normalizeHex(value);
    if (hex !== undefined && !palette.includes(hex)) palette.push(hex);
  };
  // The rendered colours lead: they are what the prospect's own page shows.
  // Logo-extracted colours follow, in prominence order.
  if (styleguide !== undefined) {
    addHex(styleguide.colors.accent);
    addHex(styleguide.colors.background);
    addHex(styleguide.colors.text);
  }
  for (const color of brand?.colors ?? []) addHex(color.hex);
  write(`  palette: ${palette.length} hexes the brief may copy from`);

  const result: EvidenceResult = {
    screenshots,
    ...(logo === undefined ? {} : { logo }),
    ...(brand === undefined ? {} : { brand: withoutRaw(brand) }),
    ...(styleguide === undefined ? {} : { styleguide: withoutRaw(styleguide) }),
    ...(fonts === undefined ? {} : { fonts: withoutRaw(fonts) }),
    ...(markdownEntry === undefined ? {} : { markdown: markdownEntry }),
    palette,
    soft,
    rawFiles,
  };
  await writeFile(path.join(paths.researchDir, evidenceFileName), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Reads the digest stage 2 and `demo:fix` work from. */
export async function readEvidence(demosRepo: string, slug: string): Promise<EvidenceResult> {
  const file = path.join(demoPaths(demosRepo, slug).researchDir, evidenceFileName);
  return JSON.parse(await readFile(file, "utf8")) as EvidenceResult;
}
