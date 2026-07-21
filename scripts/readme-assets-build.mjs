#!/usr/bin/env node
// Converts the editable SVG sources in assets/src/ into shipped copies in
// assets/ with every <text> node baked to <path> outlines, so the assets
// render correctly on GitHub (which never has Onest or Geist Mono
// installed) inside a plain <img>.
//
// Usage: node scripts/readme-assets-build.mjs
//
// Dependency choice: opentype.js is installed as a ROOT devDependency
// (`pnpm add -D -w opentype.js`, tracked in package.json/pnpm-lock.yaml).
// The root package.json already carries a flat devDependencies list for
// build tooling (@changesets/cli, turbo, typescript, vitest); adding one
// more well-scoped build-time dependency there follows that existing
// pattern and is not intrusive. This script is the only consumer.
//
// Fonts are never committed. They're downloaded on demand from Google
// Fonts (as raw TrueType, via a pre-woff2 User-Agent) and cached in the
// OS temp dir (outside the repo, so no .gitignore entry is needed).
//
// Text handling notes (read before touching the regex-based tag walker):
//   - Every source <text> element is plain text with no <tspan> children.
//     If one ever appears, this script deliberately throws rather than
//     half-supporting it — see the nested-markup check inlined in
//     findTextReplacements() (the "next tag must be </text>" assertion).
//   - font-family is sometimes set on an ancestor <g> instead of the
//     <text> itself (banner.svg's "Backed by / Y / Combinator" run). The
//     tag walker tracks a small ancestor-attribute stack to resolve it.
//   - Geist Mono has no glyph for ★ (U+2605). Browsers silently fall back
//     to a system font for that one character; we can't do that for a
//     static path, so we hand-draw a 5-point star polygon sized to the
//     text's cap height and splice it into the glyph run. Every other
//     character used in these sources (including the · middot) resolved
//     to a real glyph in both Onest and Geist Mono — verified by
//     resolveGlyph() below, which throws loudly for any *other* missing
//     glyph instead of silently mis-rendering it.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import opentypeModule from 'opentype.js';

const opentype = opentypeModule.default ?? opentypeModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SRC_DIR = join(REPO_ROOT, 'assets', 'src');
const OUT_DIR = join(REPO_ROOT, 'assets');
const CACHE_DIR = join(tmpdir(), 'vendo-readme-fonts-cache');

// Files with no <text> at all — copied through byte-for-byte.
const PASSTHROUGH_FILES = ['agent-logos.svg', 'agent-logos-dark.svg'];

// Files that do have <text> and need conversion.
const TEXT_FILES = [
  'banner.svg',
  'footer.svg',
  'badge-npm.svg',
  'badge-license.svg',
  'badge-docs.svg',
  'kicker-01-install.svg',
  'kicker-02-see-it.svg',
  'kicker-03-how-it-works.svg',
  'kicker-04-packages.svg',
];

// The exact weights used across the sources (grep-verified against
// assets/src/*.svg font-weight attributes).
const FONT_SPECS = [
  { family: 'Onest', weights: [500, 700, 800] },
  { family: 'Geist Mono', weights: [400, 600] },
];

// Google Fonts serves woff2 by default. A User-Agent old enough to predate
// woff2 support makes it fall back to raw TrueType, which opentype.js can
// parse directly with no extra decompression step.
const PRE_WOFF2_UA =
  'Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US) AppleWebKit/525.13 (KHTML, like Gecko) Version/3.1 Safari/525.13';

const PENTAGRAM_INNER_RATIO = 0.3819660112501051; // 1/phi^2

function round(n, places = 3) {
  const f = 10 ** places;
  // Avoid "-0" and trim to the shortest exact decimal representation.
  return String(Math.round((n + Number.EPSILON) * f) / f).replace(/^-0$/, '0');
}

// Cursor positions are built by repeated float `+=` across a whole text run
// (advance + kerning + letter-spacing, char after char), which accumulates
// epsilon noise — e.g. 424 becomes 424.0000000000002. opentype.js 2.0.0's
// curve-flattening in Glyph.getPath() divides by a term that can be exactly
// zero for a "clean" coordinate but not for its epsilon-perturbed neighbor,
// so the perturbed value silently produces NaN control points instead of
// throwing. Snapping every coordinate handed to getPath() to a fixed
// (small) precision closes that gap without visibly changing layout.
function snapCoord(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Font fetch + cache
// ---------------------------------------------------------------------------

function cacheFileFor(family, weight) {
  const slug = family.toLowerCase().replace(/\s+/g, '-');
  return join(CACHE_DIR, `${slug}-${weight}.ttf`);
}

async function fetchFontFaceCss(family, weights) {
  const familyParam = `${family.replace(/\s+/g, '+')}:wght@${weights.join(';')}`;
  const url = `https://fonts.googleapis.com/css2?family=${familyParam}`;
  const res = await fetch(url, { headers: { 'User-Agent': PRE_WOFF2_UA } });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google Fonts CSS for ${family}: HTTP ${res.status}`);
  }
  return res.text();
}

function parseFontFaceUrls(css) {
  // Map weight -> ttf url. Each @font-face block in the pre-woff2 response
  // is a single normal-style block per weight (no unicode-range subsets
  // for the latin-only weights we request).
  const byWeight = new Map();
  const blockRe = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const block = m[1];
    const weightM = /font-weight:\s*(\d+)/.exec(block);
    const urlM = /src:\s*url\(([^)]+)\)\s*format\('truetype'\)/.exec(block);
    if (!weightM || !urlM) continue;
    byWeight.set(Number(weightM[1]), urlM[1]);
  }
  return byWeight;
}

async function ensureFontCached(family, weight, url) {
  const dest = cacheFileFor(family, weight);
  if (existsSync(dest)) return dest;
  const res = await fetch(url, { headers: { 'User-Agent': PRE_WOFF2_UA } });
  if (!res.ok) {
    throw new Error(`Failed to download font file ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return dest;
}

/** @returns {Promise<Map<string, import('opentype.js').Font>>} keyed by "Family|weight" */
async function loadFonts() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const fonts = new Map();
  for (const { family, weights } of FONT_SPECS) {
    const missing = weights.filter((w) => !existsSync(cacheFileFor(family, w)));
    let urls = null;
    if (missing.length > 0) {
      const css = await fetchFontFaceCss(family, weights);
      urls = parseFontFaceUrls(css);
    }
    for (const w of weights) {
      let path = cacheFileFor(family, w);
      if (!existsSync(path)) {
        const url = urls?.get(w);
        if (!url) {
          throw new Error(`No truetype src found for ${family} weight ${w} in Google Fonts CSS response`);
        }
        path = await ensureFontCached(family, w, url);
      }
      const buf = readFileSync(path);
      const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const font = opentype.parse(arrayBuffer);
      fonts.set(`${family}|${w}`, font);
    }
  }
  return fonts;
}

// ---------------------------------------------------------------------------
// Minimal tag walker (regex-based, not a full XML parser)
//
// We only need to (a) resolve inherited font-family for <text> elements and
// (b) find each <text>...</text> element's exact byte span so we can splice
// a replacement in without touching anything else in the file.
// ---------------------------------------------------------------------------

const TAG_RE = /<(\/)?([a-zA-Z][\w:-]*)([^>]*?)(\/)?>/g;
const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITY_MAP[name]);
}

function parseAttrs(attrsStr) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(attrsStr))) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Walks the raw SVG source and returns a list of replacement spans:
 * { start, end, replacement } — end is exclusive, matching raw.slice(start, end).
 */
function findTextReplacements(raw, filename, resolveTextPath) {
  const replacements = [];
  const stack = []; // stack of attrs objects, innermost last
  const tags = [];
  let m;
  while ((m = TAG_RE.exec(raw))) {
    tags.push({
      isClose: Boolean(m[1]),
      name: m[2],
      attrsStr: m[3],
      isSelfClose: Boolean(m[4]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.isClose) {
      stack.pop();
      continue;
    }
    if (tag.name === 'text') {
      if (tag.isSelfClose) {
        throw new Error(`${filename}: <text> is self-closing (no content) — unexpected shape`);
      }
      const ownAttrs = parseAttrs(tag.attrsStr);
      let fontFamily = ownAttrs['font-family'];
      if (!fontFamily) {
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]['font-family']) {
            fontFamily = stack[s]['font-family'];
            break;
          }
        }
      }
      if (!fontFamily) {
        throw new Error(`${filename}: <text> at byte ${tag.start} has no font-family (own or inherited)`);
      }

      const next = tags[i + 1];
      if (!next || !next.isClose || next.name !== 'text') {
        throw new Error(
          `${filename}: <text> at byte ${tag.start} contains nested markup (e.g. <tspan>) — ` +
            `not supported by design; add explicit handling if this ever appears.`
        );
      }
      const rawContent = raw.slice(tag.end, next.start);
      if (rawContent.includes('<')) {
        throw new Error(`${filename}: <text> at byte ${tag.start} content contains a literal '<' — unsupported`);
      }
      const content = unescapeEntities(rawContent);

      const replacement = resolveTextPath({
        content,
        x: Number(ownAttrs.x ?? 0),
        y: Number(ownAttrs.y ?? 0),
        fontFamily,
        fontWeight: Number(ownAttrs['font-weight'] ?? 400),
        fontSize: Number(ownAttrs['font-size']),
        letterSpacing: ownAttrs['letter-spacing'],
        fill: ownAttrs.fill,
        textAnchor: ownAttrs['text-anchor'] ?? 'start',
      });

      replacements.push({ start: tag.start, end: next.end, replacement });
      i++; // skip the </text> we just consumed
      continue;
    }
    if (!tag.isSelfClose) {
      stack.push(parseAttrs(tag.attrsStr));
    }
  }
  return replacements;
}

function applyReplacements(raw, replacements) {
  let out = raw;
  for (const { start, end, replacement } of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text -> path
// ---------------------------------------------------------------------------

function parseLetterSpacing(attrValue, fontSizePx) {
  if (!attrValue) return 0;
  const v = attrValue.trim();
  if (v.endsWith('em')) return parseFloat(v) * fontSizePx;
  if (v.endsWith('px')) return parseFloat(v);
  return parseFloat(v); // unitless SVG length == user units == px here
}

function starPathD(cx, baselineY, capHeightPx) {
  const outerR = capHeightPx * 0.5;
  const innerR = outerR * PENTAGRAM_INNER_RATIO;
  const centerY = baselineY - capHeightPx / 2;
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const angle = (-90 + k * 36) * (Math.PI / 180);
    const r = k % 2 === 0 ? outerR : innerR;
    pts.push([cx + r * Math.cos(angle), centerY + r * Math.sin(angle)]);
  }
  const [first, ...rest] = pts;
  return `M${round(first[0])} ${round(first[1])}` + rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join('') + 'Z';
}

/** Resolves a rendering strategy for one character. Throws for anything
 * unresolvable that isn't the known ★-in-Geist-Mono gap. */
function resolveGlyph(char, font, filename) {
  const glyph = font.charToGlyph(char);
  // Verified: space (U+0020) maps to a real, non-.notdef glyph in all five
  // loaded font files (Onest 500/700/800, Geist Mono 400/600) — no
  // exemption needed here.
  if (glyph.index !== 0) {
    return { kind: 'glyph', glyph };
  }
  if (char === '★') {
    return { kind: 'star' };
  }
  throw new Error(
    `${filename}: character ${JSON.stringify(char)} (U+${char.codePointAt(0).toString(16)}) has no glyph in ` +
      `this font and is not a known hand-drawn substitution (only ★ is handled) — add explicit handling.`
  );
}

function textToPath({ content, x, y, fontFamily, fontWeight, fontSize, letterSpacing, fill, textAnchor }, fonts, filename) {
  const font = fonts.get(`${fontFamily}|${fontWeight}`);
  if (!font) {
    throw new Error(`${filename}: no loaded font for "${fontFamily}" weight ${fontWeight}`);
  }
  if (textAnchor !== 'start' && textAnchor !== 'middle') {
    throw new Error(`${filename}: unsupported text-anchor "${textAnchor}"`);
  }
  const scale = fontSize / font.unitsPerEm;
  const letterSpacingPx = parseLetterSpacing(letterSpacing, fontSize);
  const chars = Array.from(content);
  const resolved = chars.map((ch) => resolveGlyph(ch, font, filename));

  // Monospace cell width, used both as the generic star-slot width and to
  // sanity-check kerning lookups are meaningful (kerning is 0 throughout
  // Geist Mono; Onest headlines carry real kerning pairs).
  const cellAdvanceUnits = font.charToGlyph('0').advanceWidth;

  // Per-char own advance (px) and kerning-to-previous (px). Matches how
  // browsers compute getComputedTextLength — verified against live
  // Chromium rendering: kerning is added, and letter-spacing is counted
  // once per character including the trailing one (it just never moves a
  // visible glyph for start-anchored text).
  const ownAdvancePx = resolved.map((r) => (r.kind === 'glyph' ? r.glyph.advanceWidth : cellAdvanceUnits) * scale);
  const kerningPx = resolved.map((r, i) => {
    if (i === 0 || r.kind !== 'glyph' || resolved[i - 1].kind !== 'glyph') return 0;
    return font.getKerningValue(resolved[i - 1].glyph, r.glyph) * scale;
  });
  const totalWidth =
    ownAdvancePx.reduce((a, b) => a + b, 0) + kerningPx.reduce((a, b) => a + b, 0) + letterSpacingPx * chars.length;
  const startX = textAnchor === 'middle' ? x - totalWidth / 2 : x;

  const os2 = font.tables.os2;
  const capHeightPx = ((os2 && os2.sCapHeight) || font.unitsPerEm * 0.7) * scale;

  let cursor = startX;
  const segments = [];
  for (let i = 0; i < chars.length; i++) {
    const r = resolved[i];
    cursor += kerningPx[i];
    if (r.kind === 'glyph') {
      const path = r.glyph.getPath(snapCoord(cursor), snapCoord(y), fontSize);
      const d = path.toPathData(3);
      if (d) segments.push(d);
    } else {
      segments.push(starPathD(snapCoord(cursor + ownAdvancePx[i] / 2), snapCoord(y), capHeightPx));
    }
    cursor += ownAdvancePx[i] + letterSpacingPx;
  }

  return `<path d="${segments.join(' ')}" fill="${fill}"/>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const file of PASSTHROUGH_FILES) {
    copyFileSync(join(SRC_DIR, file), join(OUT_DIR, file));
  }

  const fonts = await loadFonts();

  for (const file of TEXT_FILES) {
    const srcPath = join(SRC_DIR, file);
    const raw = readFileSync(srcPath, 'utf8');
    const replacements = findTextReplacements(raw, file, (spec) => textToPath(spec, fonts, file));
    // Every <text> is gone at this point, but an ancestor <g> may still
    // carry a font-family attribute purely for inheritance purposes (e.g.
    // banner.svg's "Backed by / Y / Combinator" group) — it's inert now
    // that its children are <path>s, so strip it to keep the shipped file
    // free of any font references.
    const out = applyReplacements(raw, replacements).replace(/\s+font-family="[^"]*"/g, '');
    if (/<text[\s>]/.test(out) || /font-family/.test(out)) {
      throw new Error(`${file}: output still contains <text> or font-family after conversion`);
    }
    // Belt-and-suspenders: opentype.js curve flattening can silently emit
    // NaN control points for certain coordinates (see snapCoord() above).
    // A NaN in path data makes browsers abort mid-parse, truncating
    // everything after it — fail the build loudly instead of shipping that.
    if (/NaN/.test(out)) {
      throw new Error(`${file}: emitted path data contains NaN — a glyph coordinate was not finite`);
    }
    writeFileSync(join(OUT_DIR, basename(file)), out);
  }

  console.log(`Wrote ${PASSTHROUGH_FILES.length + TEXT_FILES.length} files to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
