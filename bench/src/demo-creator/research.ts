import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";

/**
 * `demo:research` — evidence-gathering for the creator agent, not automated
 * extraction: per-URL viewport + full-page screenshots, page title, meta
 * theme-color, favicon, a computed-style sample of the obvious brand carriers
 * (body/header/nav/buttons/links) mapped to named color roles, font evidence
 * (resolved families, same-origin @font-face sources, webfont links — never
 * downloaded), and downloaded logo/icon assets in RESEARCH/assets/. The
 * creator agent does the judging; there is deliberately no color clustering,
 * CSS parsing beyond @font-face, or theme generation here.
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
  /** The full computed font-family stack. */
  fontFamily: string;
  /** The first family in the stack that `document.fonts.check` reports available. */
  firstFontFamily: string;
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

/** One sampled color mapped to the token role it evidences. */
export interface ColorRole {
  role: string;
  color: string;
  /** The StyleSample target the color came from. */
  target: string;
}

/** Maps the sampled brand carriers to named token roles (body-bg, header-bg,
 * primary-button-bg, link, ...) so the creator can copy exact hexes into
 * theme tokens instead of guessing which color plays which part. */
export function deriveColorRoles(samples: readonly StyleSample[]): ColorRole[] {
  const roles: ColorRole[] = [];
  const push = (role: string, color: string, target: string): void => {
    if (!emptyColorValues.has(color)) roles.push({ role, color, target });
  };
  let primaryButtonSeen = false;
  let linkSeen = false;
  for (const entry of samples) {
    if (entry.target === "body" || entry.target === "header" || entry.target === "nav") {
      push(`${entry.target}-bg`, entry.backgroundColor, entry.target);
      push(`${entry.target}-text`, entry.color, entry.target);
    } else if (entry.target.startsWith("button")) {
      // The first button with a visible background is the best primary-button
      // evidence; ghost/icon buttons (transparent) don't qualify.
      if (!primaryButtonSeen && !emptyColorValues.has(entry.backgroundColor)) {
        primaryButtonSeen = true;
        push("primary-button-bg", entry.backgroundColor, entry.target);
        push("primary-button-text", entry.color, entry.target);
      }
    } else if (entry.target.startsWith("a[") && !linkSeen) {
      linkSeen = true;
      push("link", entry.color, entry.target);
    }
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Brand-asset harvesting (logos, favicons, social images)
// ---------------------------------------------------------------------------

export type AssetKind = "logo" | "favicon" | "apple-touch-icon" | "og-image" | "twitter-image";

/** One downloadable/serializable brand-asset lead found on a page. */
export interface AssetCandidate {
  kind: AssetKind;
  /** Absolute source URL; null for inline SVGs (which carry `svgMarkup`). */
  url: string | null;
  /** Serialized outerHTML of an inline `<svg>` logo. */
  svgMarkup?: string;
  /** Where it was found, e.g. 'link[rel="icon"]', "header svg", "nav img". */
  source: string;
  /** For logos: header | nav | logo | home-link — feeds the file name. */
  locationHint?: string;
  width?: number;
  height?: number;
}

/** Raw asset evidence as collected inside the page (serialization-friendly). */
export interface PageAssetEvidence {
  iconLinks: { rel: string; href: string; sizes?: string | null }[];
  metaImages: { kind: "og-image" | "twitter-image"; url: string }[];
  logoImages: { url: string; source: string; locationHint: string; width?: number; height?: number }[];
  logoSvgs: { markup: string; source: string; locationHint: string; width?: number; height?: number }[];
}

function parseIconSize(sizes: string | null | undefined): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/i.exec(sizes?.trim() ?? "");
  if (match === null) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Turns raw in-page evidence into typed asset candidates, logos first. */
export function collectAssetCandidates(evidence: PageAssetEvidence): AssetCandidate[] {
  const candidates: AssetCandidate[] = [];
  for (const svg of evidence.logoSvgs) {
    candidates.push({
      kind: "logo",
      url: null,
      svgMarkup: svg.markup,
      source: svg.source,
      locationHint: svg.locationHint,
      ...(svg.width !== undefined ? { width: svg.width } : {}),
      ...(svg.height !== undefined ? { height: svg.height } : {}),
    });
  }
  for (const img of evidence.logoImages) {
    candidates.push({
      kind: "logo",
      url: img.url,
      source: img.source,
      locationHint: img.locationHint,
      ...(img.width !== undefined ? { width: img.width } : {}),
      ...(img.height !== undefined ? { height: img.height } : {}),
    });
  }
  for (const link of evidence.iconLinks) {
    const kind: AssetKind = link.rel.includes("apple") ? "apple-touch-icon" : "favicon";
    const size = parseIconSize(link.sizes);
    candidates.push({
      kind,
      url: link.href,
      source: `link[rel="${link.rel}"]`,
      ...(size !== undefined ? size : {}),
    });
  }
  for (const meta of evidence.metaImages) {
    candidates.push({
      kind: meta.kind,
      url: meta.url,
      source: meta.kind === "og-image" ? 'meta[property="og:image"]' : 'meta[name="twitter:image"]',
    });
  }
  return candidates;
}

const knownImageExtensions = new Set(["svg", "png", "ico", "jpg", "jpeg", "gif", "webp", "avif"]);

function extensionFromAssetUrl(url: string): string | null {
  try {
    const match = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
    const extension = match?.[1]?.toLowerCase();
    return extension !== undefined && knownImageExtensions.has(extension) ? extension : null;
  } catch {
    return null;
  }
}

const contentTypeExtensions: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Extension for a downloaded asset whose URL didn't reveal one. */
export function extensionForContentType(contentType: string): string {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return contentTypeExtensions[bare] ?? "img";
}

function isDownloadableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Sort order under the per-page cap: logos are the point of the harvest. */
const assetKindPriority: Record<AssetKind, number> = {
  logo: 0,
  favicon: 1,
  "apple-touch-icon": 2,
  "og-image": 3,
  "twitter-image": 4,
};

export interface PlannedAsset {
  /** File name without extension, unique across the whole run. */
  fileStem: string;
  /** Known extension, or null to derive from the response Content-Type. */
  extension: string | null;
  /** URL, or a content hash for inline SVGs — the cross-page dedupe identity. */
  dedupeKey: string;
  candidate: AssetCandidate;
}

/** Icon-heavy headers (Linear's has ~15 inline SVGs) must not crowd the
 * favicons/social images out of the per-page cap. */
const maxLogoAssets = 8;

/** Dedupes, prioritizes, caps, and names the assets to save for one page.
 * Pure: the runner passes `usedStems` from earlier pages and does the I/O. */
export function planAssetDownloads(
  candidates: readonly AssetCandidate[],
  options: { maxAssets?: number; usedStems?: ReadonlySet<string> } = {},
): PlannedAsset[] {
  const maxAssets = options.maxAssets ?? 12;
  const usedStems = new Set(options.usedStems ?? []);
  const seenKeys = new Set<string>();
  const eligible: { candidate: AssetCandidate; dedupeKey: string }[] = [];
  for (const candidate of candidates) {
    const inlineSvg = candidate.svgMarkup !== undefined && candidate.svgMarkup.trim() !== "";
    if (!inlineSvg && (candidate.url === null || !isDownloadableUrl(candidate.url))) continue;
    const dedupeKey = inlineSvg
      ? `svg:${createHash("sha256").update(candidate.svgMarkup ?? "").digest("hex").slice(0, 16)}`
      : (candidate.url as string);
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    eligible.push({ candidate, dedupeKey });
  }
  eligible.sort((a, b) => assetKindPriority[a.candidate.kind] - assetKindPriority[b.candidate.kind]);

  const planned: PlannedAsset[] = [];
  let logoCount = 0;
  for (const { candidate, dedupeKey } of eligible) {
    if (planned.length >= maxAssets) break;
    if (candidate.kind === "logo" && logoCount >= maxLogoAssets) continue;
    let base: string;
    if (candidate.kind === "logo") {
      logoCount += 1;
      base = `logo-${logoCount}-${candidate.locationHint ?? "page"}`;
    } else if (candidate.kind === "favicon" && candidate.width !== undefined) {
      base = `favicon-${candidate.width}`;
    } else {
      base = candidate.kind;
    }
    let fileStem = base;
    for (let suffix = 2; usedStems.has(fileStem); suffix += 1) fileStem = `${base}-${suffix}`;
    usedStems.add(fileStem);
    const extension = candidate.svgMarkup !== undefined ? "svg" : extensionFromAssetUrl(candidate.url as string);
    planned.push({ fileStem, extension, dedupeKey, candidate });
  }
  return planned;
}

/** One harvested asset as recorded in research.json. */
export interface ResearchAsset {
  kind: AssetKind;
  /** Element/source descriptor, e.g. 'link[rel="icon"]', "header svg". */
  source: string;
  /** Source URL; null for inline SVGs serialized out of the DOM. */
  url: string | null;
  /** Saved path relative to RESEARCH/ (e.g. "assets/logo-1-header.svg"); null if skipped. */
  file: string | null;
  width?: number;
  height?: number;
  /** Why the asset was not saved (over-2MB, HTTP error, ...). */
  skipped?: string;
}

// ---------------------------------------------------------------------------
// Font evidence (never downloads font files)
// ---------------------------------------------------------------------------

/** One @font-face declaration's family + one resolved src URL. */
export interface FontFaceEvidence {
  family: string;
  src: string;
}

export interface ResearchFonts {
  /** Resolved (actually rendering) families + declared @font-face families, deduped. */
  families: string[];
  /** @font-face sources from same-origin stylesheets — evidence only, never downloaded. */
  faceSrcs: FontFaceEvidence[];
  /** Google Fonts / other webfont-host stylesheet links. */
  webfontLinks: string[];
}

const webfontHosts = new Set([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
  "p.typekit.net",
  "fonts.bunny.net",
  "fonts.cdnfonts.com",
  "rsms.me",
]);

/** Whether a stylesheet/preload link points at a known webfont host. */
export function isWebfontLink(href: string): boolean {
  try {
    return webfontHosts.has(new URL(href).hostname);
  } catch {
    return false;
  }
}

/** Extracts every url() from a raw @font-face src declaration and resolves it
 * against the declaring stylesheet's URL; data: URLs are dropped. */
export function extractFontFaceSrcUrls(src: string, baseHref: string): string[] {
  const urls: string[] = [];
  for (const match of src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const raw = match[2]?.trim() ?? "";
    if (raw === "" || raw.startsWith("data:")) continue;
    let resolved: string;
    try {
      resolved = new URL(raw, baseHref).href;
    } catch {
      continue;
    }
    if (!urls.includes(resolved)) urls.push(resolved);
  }
  return urls;
}

/** Aggregates per-page font evidence into research.json's top-level `fonts`. */
export function aggregateFonts(pages: readonly ResearchPageEntry[]): ResearchFonts {
  const families: string[] = [];
  const faceSrcs: FontFaceEvidence[] = [];
  const seenFaces = new Set<string>();
  const webfontLinks: string[] = [];
  const addFamily = (family: string): void => {
    if (family !== "" && !families.includes(family)) families.push(family);
  };
  for (const page of pages) {
    if ("error" in page) continue;
    for (const entry of page.samples) addFamily(entry.firstFontFamily);
    for (const face of page.fontFaces) {
      addFamily(face.family);
      const key = `${face.family}|${face.src}`;
      if (!seenFaces.has(key)) {
        seenFaces.add(key);
        faceSrcs.push(face);
      }
    }
    for (const link of page.webfontLinks) {
      if (!webfontLinks.includes(link)) webfontLinks.push(link);
    }
  }
  return { families, faceSrcs, webfontLinks };
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
  /** Sampled colors mapped to token roles (body-bg, primary-button-bg, ...). */
  colorRoles: ColorRole[];
  /** @font-face evidence from same-origin stylesheets. */
  fontFaces: FontFaceEvidence[];
  /** Webfont stylesheet links (Google Fonts etc.) found in the head. */
  webfontLinks: string[];
  /** Harvested logo/icon assets (saved under RESEARCH/assets/, or skipped). */
  assets: ResearchAsset[];
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
  fonts: ResearchFonts;
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
    fonts: aggregateFonts(options.pages),
  };
}

/** A realistic desktop UA — headless Chromium's default advertises
 * "HeadlessChrome", which trips even soft bot heuristics. */
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface InPageEvidence {
  title: string;
  themeColor: string | null;
  favicon: string | null;
  samples: StyleSample[];
  assetEvidence: PageAssetEvidence;
  /** Raw @font-face declarations; parsed/resolved node-side (testable). */
  fontFacesRaw: { family: string; src: string; baseHref: string }[];
  /** Every stylesheet/preload link href; filtered node-side by isWebfontLink. */
  linkHrefs: string[];
}

/** Runs inside the page; must stay self-contained (serialized by Playwright). */
function collectBrandEvidenceInPage(): InPageEvidence {
  const firstResolvedFamily = (stack: string): string => {
    const families = stack
      .split(",")
      .map((family) => family.trim().replace(/^["']|["']$/g, ""))
      .filter((family) => family !== "");
    for (const family of families) {
      try {
        if (document.fonts.check(`12px "${family}"`)) return family;
      } catch {
        // malformed family name — keep looking
      }
    }
    return families[0] ?? "";
  };
  const samples: StyleSample[] = [];
  const sampleElement = (target: string, element: Element | null): void => {
    if (element === null) return;
    const style = window.getComputedStyle(element);
    samples.push({
      target,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontFamily: style.fontFamily,
      firstFontFamily: firstResolvedFamily(style.fontFamily),
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

  // --- asset evidence ---
  const iconLinks: PageAssetEvidence["iconLinks"] = [];
  document.querySelectorAll<HTMLLinkElement>('link[rel*="icon"]').forEach((link) => {
    if (link.href !== "") iconLinks.push({ rel: link.rel, href: link.href, sizes: link.getAttribute("sizes") });
  });
  const metaImages: PageAssetEvidence["metaImages"] = [];
  const pushMetaImage = (kind: "og-image" | "twitter-image", selector: string): void => {
    const content = document.querySelector<HTMLMetaElement>(selector)?.content ?? "";
    if (content === "") return;
    try {
      metaImages.push({ kind, url: new URL(content, location.href).href });
    } catch {
      // unresolvable content — not evidence
    }
  };
  pushMetaImage("og-image", 'meta[property="og:image"]');
  pushMetaImage("twitter-image", 'meta[name="twitter:image"], meta[property="twitter:image"]');

  const logoImages: PageAssetEvidence["logoImages"] = [];
  const logoSvgs: PageAssetEvidence["logoSvgs"] = [];
  const seenLogoElements = new Set<Element>();
  const logoContainers: [string, string][] = [
    ["header", "header"],
    ["nav", "nav"],
    ['[class*="logo" i]', "logo"],
    ['a[href="/"]', "home-link"],
  ];
  const serializer = new XMLSerializer();
  for (const [selector, locationHint] of logoContainers) {
    document.querySelectorAll(selector).forEach((container, containerIndex) => {
      if (containerIndex >= 4) return;
      // The container itself may be the <img>/<svg> (e.g. class="logo").
      const nested = Array.from(container.querySelectorAll("img, svg"));
      const elements = container.matches("img, svg") ? [container, ...nested] : nested;
      let taken = 0;
      for (const element of elements) {
        if (taken >= 6) break;
        if (seenLogoElements.has(element)) continue;
        seenLogoElements.add(element);
        if (element.tagName.toLowerCase() === "img") {
          const img = element as HTMLImageElement;
          const url = img.currentSrc !== "" ? img.currentSrc : img.src;
          if (url === "") continue;
          logoImages.push({
            url,
            source: `${locationHint} img`,
            locationHint,
            width: img.naturalWidth > 0 ? img.naturalWidth : undefined,
            height: img.naturalHeight > 0 ? img.naturalHeight : undefined,
          });
        } else {
          const markup = serializer.serializeToString(element);
          if (markup.length === 0 || markup.length > 300_000) continue;
          const rect = element.getBoundingClientRect();
          logoSvgs.push({
            markup,
            source: `${locationHint} svg`,
            locationHint,
            width: rect.width > 0 ? Math.round(rect.width) : undefined,
            height: rect.height > 0 ? Math.round(rect.height) : undefined,
          });
        }
        taken += 1;
      }
    });
  }

  // --- font evidence ---
  const fontFacesRaw: InPageEvidence["fontFacesRaw"] = [];
  const collectFontFaceRules = (rules: CSSRuleList | null, baseHref: string): void => {
    for (const rule of Array.from(rules ?? [])) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const style = (rule as CSSFontFaceRule).style;
        const family = style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
        const src = style.getPropertyValue("src");
        if (family !== "" && src !== "") fontFacesRaw.push({ family, src, baseHref });
      } else if ("cssRules" in rule) {
        // one nested level (@media/@supports wrapping @font-face)
        try {
          collectFontFaceRules((rule as CSSGroupingRule).cssRules, baseHref);
        } catch {
          // inaccessible nested rules
        }
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet — webfont links cover these
    }
    collectFontFaceRules(rules, sheet.href ?? location.href);
  }
  const linkHrefs: string[] = [];
  document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"], link[rel="preload"]').forEach((link) => {
    if (link.href !== "") linkHrefs.push(link.href);
  });

  const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  return {
    title: document.title,
    themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null,
    favicon: favicon?.href ?? null,
    samples,
    assetEvidence: { iconLinks, metaImages, logoImages, logoSvgs },
    fontFacesRaw,
    linkHrefs,
  };
}

const maxAssetBytes = 2 * 1024 * 1024;

/** Cross-page download state: dedupe identities → saved RESEARCH-relative paths. */
interface AssetHarvestState {
  savedByKey: Map<string, string>;
  usedStems: Set<string>;
}

async function savePlannedAssets(options: {
  context: BrowserContext;
  planned: PlannedAsset[];
  researchDir: string;
  state: AssetHarvestState;
}): Promise<ResearchAsset[]> {
  const assets: ResearchAsset[] = [];
  for (const plan of options.planned) {
    const { candidate } = plan;
    const base: ResearchAsset = {
      kind: candidate.kind,
      source: candidate.source,
      url: candidate.url,
      file: null,
      ...(candidate.width !== undefined ? { width: candidate.width } : {}),
      ...(candidate.height !== undefined ? { height: candidate.height } : {}),
    };
    const existing = options.state.savedByKey.get(plan.dedupeKey);
    if (existing !== undefined) {
      assets.push({ ...base, file: existing });
      continue;
    }
    try {
      let file: string;
      if (candidate.svgMarkup !== undefined) {
        file = `assets/${plan.fileStem}.svg`;
        await mkdir(path.join(options.researchDir, "assets"), { recursive: true });
        await writeFile(path.join(options.researchDir, file), candidate.svgMarkup);
      } else {
        const response = await options.context.request.get(candidate.url as string, { timeout: 15_000 });
        if (!response.ok()) {
          assets.push({ ...base, skipped: `HTTP ${response.status()}` });
          continue;
        }
        const body = await response.body();
        if (body.byteLength > maxAssetBytes) {
          assets.push({ ...base, skipped: `over-2MB (${body.byteLength} bytes)` });
          continue;
        }
        const extension = plan.extension ?? extensionForContentType(response.headers()["content-type"] ?? "");
        file = `assets/${plan.fileStem}.${extension}`;
        await mkdir(path.join(options.researchDir, "assets"), { recursive: true });
        await writeFile(path.join(options.researchDir, file), body);
      }
      options.state.savedByKey.set(plan.dedupeKey, file);
      assets.push({ ...base, file });
    } catch (error) {
      assets.push({ ...base, skipped: error instanceof Error ? error.message : String(error) });
    }
  }
  return assets;
}

async function capturePage(options: {
  context: BrowserContext;
  url: string;
  index: number;
  researchDir: string;
  assetState: AssetHarvestState;
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
  const planned = planAssetDownloads(collectAssetCandidates(evidence.assetEvidence), {
    usedStems: options.assetState.usedStems,
  });
  for (const plan of planned) options.assetState.usedStems.add(plan.fileStem);
  const assets = await savePlannedAssets({
    context: options.context,
    planned,
    researchDir: options.researchDir,
    state: options.assetState,
  });
  const fontFaces: FontFaceEvidence[] = [];
  const seenFaces = new Set<string>();
  for (const raw of evidence.fontFacesRaw) {
    for (const src of extractFontFaceSrcUrls(raw.src, raw.baseHref)) {
      const key = `${raw.family}|${src}`;
      if (seenFaces.has(key)) continue;
      seenFaces.add(key);
      fontFaces.push({ family: raw.family, src });
    }
  }
  const webfontLinks = [...new Set(evidence.linkHrefs.filter(isWebfontLink))];
  return {
    url: options.url,
    title: evidence.title,
    themeColor: evidence.themeColor,
    favicon: evidence.favicon,
    samples: evidence.samples,
    botChallenge: isBotChallengeTitle(evidence.title),
    screenshots,
    colorRoles: deriveColorRoles(evidence.samples),
    fontFaces,
    webfontLinks,
    assets,
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
  const assetState: AssetHarvestState = { savedByKey: new Map(), usedStems: new Set() };
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    for (const [index, url] of args.urls.entries()) {
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent });
        pages.push(await capturePage({ context, url, index, researchDir, assetState }));
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
