import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { demoPaths, normalizeHex } from "./demo-folder.js";

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
  if (contentType.toLowerCase().includes("svg")) return true;
  const head = bytes.subarray(0, 256).toString("utf8").trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml");
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

export async function runEvidence(args: EvidenceArgs, io: EvidenceIo): Promise<EvidenceResult> {
  if (args.screenshots.length === 0) {
    throw new Error("evidence: at least one reference screenshot is required (--screenshots /abs/a.png,/abs/b.png)");
  }
  const write = io.write ?? ((): void => {});
  const paths = demoPaths(io.demosRepo, args.slug);
  await mkdir(paths.contextDevDir, { recursive: true });
  await mkdir(paths.brandDir, { recursive: true });

  const screenshots: EvidenceScreenshot[] = [];
  for (const [index, source] of args.screenshots.entries()) {
    // Indexed so two files both named screenshot.png cannot overwrite each
    // other, and so the brief can cite them in the operator's order.
    const file = `${index + 1}-${path.basename(source)}`;
    try {
      await copyFile(source, path.join(paths.researchDir, file));
    } catch (error) {
      throw new Error(`evidence: cannot read the reference screenshot "${source}": ${failureReason(error)}`);
    }
    screenshots.push({ file, source });
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

  const domain = args.url === undefined ? undefined : domainFromUrl(args.url);
  const noDomainReason =
    args.url === undefined
      ? "no --url given — this call is keyed on the prospect's site"
      : `no --url given that resolves to a domain (${args.url})`;

  const brand = await attempt("retrieve-brand", () =>
    domain === undefined ? client.retrieveBrand({ name: args.prospect }) : client.retrieveBrand({ domain }),
  );
  if (brand !== undefined) {
    write(`  retrieve-brand: ${brand.colors.length} colours, ${brand.logos.length} logos`);
  }

  let styleguide: StyleguideResult | undefined;
  let fonts: FontsResult | undefined;
  let markdown: MarkdownResult | undefined;
  if (domain === undefined) {
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
      client.scrapeMarkdown({ url: args.url as string, useMainContentOnly: true }),
    );
    if (markdown !== undefined) write(`  scrape-markdown: ${markdown.contentLength} bytes of site text`);
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
        const svg = isSvg(response.headers.get("content-type") ?? "", bytes);
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
