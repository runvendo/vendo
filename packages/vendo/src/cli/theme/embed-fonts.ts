import { promises as fs } from "node:fs";
import path from "node:path";
import type { VendoThemeFont } from "@vendoai/apps/contract";
import { walk } from "./walk.js";

/**
 * Host fonts, inlined — the other half of theme extraction.
 *
 * Extraction learns that the brand font is "Inter". That name is enough for the
 * host's own pages and useless everywhere else: a generated screen renders in
 * surfaces the host's stylesheet never reaches (the jail iframe, the MCP Apps
 * shim, a served box), where "Inter" resolves to whatever the surface happens
 * to have — normally nothing. So the name has to become bytes.
 *
 * Three sources, ordered by how much each proves about what the host actually
 * ships:
 *   1. next/font's build output — the exact files the host's own pages serve.
 *   2. The host's own `@font-face` rules, pointing at files under `public/`.
 *   3. The Google Fonts css2 API, for a family the host only ever names.
 *
 * (1) and (3) are re-resolved on EVERY run and never recorded: next/font's
 * filenames carry a per-build hash and gstatic's carry a font version, so a
 * stored path is a path that rots. The output is a stylesheet of data-URI
 * faces; `.vendo/theme.json` gets the metadata only (`typography.fonts`).
 *
 * No license logic — the file is taken as it is found. No glyph subsetting
 * either: a subset is only ever CHOSEN, and only when the source already
 * publishes per-subset files, which both next/font and css2 do.
 */

type FontSource = VendoThemeFont["source"];

interface Face {
  family: string;
  weight: string;
  style: string;
  /** Absolute file path, or an https URL. */
  src: string;
  source: FontSource;
  unicodeRange: string | undefined;
}

export interface EmbeddedFonts {
  /** The `.vendo/fonts.css` body; empty when nothing resolved. */
  css: string;
  fonts: VendoThemeFont[];
  /** Total font-file bytes inlined, before base64. */
  bytes: number;
  /** One line per family that resolved or didn't — sync prints these. */
  notes: string[];
}

/** css2 serves woff2 only to a user agent it believes can read it. */
const WOFF2_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Generic keywords and system stacks name no file — never worth a lookup. */
const GENERIC = /^(?:ui-|-apple-system$|BlinkMacSystemFont$|system-ui$|sans-serif$|serif$|monospace$|cursive$|fantasy$|emoji$|math$|inherit$|initial$)/i;

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function declaration(body: string, name: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(body)?.[1]?.trim();
}

/** The `@font-face` rules in one sheet, each pointing at the first woff2 its
 *  `src` offers. `locate` turns that URL into a file path or an https URL, or
 *  null for a face this source cannot reach. */
function parseFaces(css: string, source: FontSource, locate: (url: string) => string | null): Face[] {
  const faces: Face[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1]!;
    const family = declaration(body, "font-family");
    const url = /url\(\s*['"]?([^'")\s]+\.woff2)/i.exec(body)?.[1];
    if (family === undefined || url === undefined) continue;
    const src = locate(url);
    if (src === null) continue;
    faces.push({
      family: unquote(family),
      weight: declaration(body, "font-weight") ?? "400",
      style: declaration(body, "font-style") ?? "normal",
      src,
      source,
      unicodeRange: declaration(body, "unicode-range"),
    });
  }
  return faces;
}

/** Keep the latin cut. Both producers label subsets by `unicode-range` alone,
 *  and both spell the basic latin block as a range starting at zero: css2
 *  writes `U+0000-00FF`, Turbopack minifies the same block to the wildcard
 *  `U+??`. A face with no range is the whole font — always kept. */
function isLatin(face: Face): boolean {
  if (face.unicodeRange === undefined) return true;
  const first = face.unicodeRange.split(",")[0]!.trim().replace(/^U\+/i, "").split("-")[0]!;
  return Number.parseInt(first.replaceAll("?", "0"), 16) === 0;
}

async function readFile(file: string): Promise<Buffer | null> {
  return fs.readFile(file).catch(() => null);
}

/** next/font writes its faces into the build's CSS chunks, pointing at
 *  `../media/<hash>.woff2` (Turbopack) or `/_next/static/media/…` (webpack).
 *  The hash moves every build, which is precisely why this runs at sync time. */
async function nextFontFaces(root: string): Promise<Face[]> {
  const faces: Face[] = [];
  for (const dir of [path.join(root, ".next/static/chunks"), path.join(root, ".next/static/css")]) {
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries.filter((name) => name.endsWith(".css"))) {
      const css = await fs.readFile(path.join(dir, entry), "utf8").catch(() => null);
      if (css === null) continue;
      faces.push(...parseFaces(css, "next/font", (url) => url.startsWith("/_next/")
        ? path.join(root, ".next", url.slice("/_next/".length))
        : path.resolve(dir, url)));
    }
  }
  return faces;
}

/** The host's own faces: an `@font-face` anywhere in its source CSS whose file
 *  is really on disk (a rule for a font the host never shipped resolves to
 *  nothing, and must lose to the network lookup rather than beat it). */
async function publicFaces(root: string): Promise<Face[]> {
  const faces: Face[] = [];
  for (const file of await walk(root, (relative) => relative.endsWith(".css"))) {
    const css = await fs.readFile(file, "utf8").catch(() => null);
    if (css === null) continue;
    for (const face of parseFaces(css, "public", (url) => url.startsWith("/")
      ? path.join(root, "public", url)
      : path.resolve(path.dirname(file), url))) {
      if (await fs.stat(face.src).then(() => true, () => false)) faces.push(face);
    }
  }
  return faces;
}

/** The css2 API, asked fresh every run so nothing pins a gstatic URL. An
 *  unknown family answers 400, which is the miss reported to the user. */
async function googleFaces(family: string): Promise<Face[]> {
  const query = `family=${encodeURIComponent(`${family}:wght@400;600`)}&display=swap`;
  const response = await fetch(`https://fonts.googleapis.com/css2?${query}`, {
    headers: { "user-agent": WOFF2_UA },
  }).catch(() => null);
  if (response === null || !response.ok) return [];
  return parseFaces(await response.text(), "google", (url) => url);
}

function faceCss(face: Face, data: Buffer): string {
  return `@font-face {
  font-family: '${face.family}';
  font-style: ${face.style};
  font-weight: ${face.weight};
  font-display: swap;
  src: url(data:font/woff2;base64,${data.toString("base64")}) format('woff2');${
  face.unicodeRange === undefined ? "" : `\n  unicode-range: ${face.unicodeRange};`}
}`;
}

/** The families worth resolving: the head of each stack the theme names, since
 *  the entries after it are the host's own fallbacks.
 *
 *  Read off the theme DOCUMENT that is about to be written — never off a fresh
 *  extraction. A host's pinned typeface survives reconciliation while the
 *  app's own CSS says something else, so resolving from the extraction embedded
 *  the family the host had deliberately rejected. */
export function themeFontFamilies(theme: unknown): string[] {
  const typography = (theme as { typography?: Record<string, unknown> } | null)?.typography;
  const heads = [typography?.["fontFamily"], typography?.["headingFamily"], typography?.["monoFamily"]]
    .filter((stack): stack is string => typeof stack === "string")
    .map((stack) => unquote(stack.split(",")[0]!));
  return [...new Set(heads.filter((family) => family !== "" && !GENERIC.test(family)))];
}

/** `theme` is the VendoTheme document being persisted — the SAME object the
 *  faces are then recorded on, so the sheet and the selection cannot disagree. */
export async function embedHostFonts(root: string, theme: unknown): Promise<EmbeddedFonts> {
  const families = themeFontFamilies(theme);
  if (families.length === 0) return { css: "", fonts: [], bytes: 0, notes: [] };
  const local = [...await nextFontFaces(root), ...await publicFaces(root)];

  const blocks: string[] = [];
  const fonts: VendoThemeFont[] = [];
  const notes: string[] = [];
  let bytes = 0;
  for (const family of families) {
    const matched = local.filter((face) => face.family.toLowerCase() === family.toLowerCase());
    const faces = (matched.length > 0 ? matched : await googleFaces(family)).filter(isLatin);
    if (faces.length === 0) {
      notes.push(`${family}: no font file found`);
      continue;
    }
    for (const face of faces) {
      const data = face.src.startsWith("https:")
        ? await fetch(face.src).then(async (r) => r.ok ? Buffer.from(await r.arrayBuffer()) : null, () => null)
        : await readFile(face.src);
      if (data === null) {
        notes.push(`${family}: could not read ${face.src}`);
        continue;
      }
      bytes += data.length;
      blocks.push(faceCss(face, data));
      fonts.push({ family: face.family, weight: face.weight, style: face.style, source: face.source });
    }
    notes.push(`${family}: ${faces.length} face(s) from ${faces[0]!.source}`);
  }
  return { css: blocks.length === 0 ? "" : `${blocks.join("\n")}\n`, fonts, bytes, notes };
}
