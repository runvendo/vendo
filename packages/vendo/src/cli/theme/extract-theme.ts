import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { ENTRY_FILE_CANDIDATES } from "./entry-candidates.js";
import { collectNextFontVars, collectNextLayoutVars, TAILWIND_NEUTRAL_COLORS } from "./next-fonts.js";
import {
  mapVarsToBrand,
  normalizeColorVar,
  type BrandMappingResult,
  type InferredSlotValue,
  type ThemeSlotValues,
} from "./map-to-brand.js";
import { resolveWorkspacePackageSpecifier } from "./workspace-resolve.js";
import { walk } from "./walk.js";

export interface ThemeSummary extends BrandMappingResult {
  errors: string[];
  varCount: number;
}

const SOURCE_WITH_CSS_IMPORTS = /\.(tsx|jsx|ts|js|mjs|cjs)$/;
const CSS_IMPORT_RE = /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+\.css)["']/g;
const CSS_REQUIRE_RE = /\brequire\(\s*["']([^"']+\.css)["']\s*\)/g;
const CSS_AT_IMPORT_RE = /@import\s+(url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^"')\s;]+))\s*\)?/g;
const ENTRY_SOURCE_FILE = /(^|\/)(app\/(?:[^/]+\/)*layout|src\/app\/(?:[^/]+\/)*layout|pages\/_app|src\/pages\/_app)\.(tsx|jsx|ts|js|mjs)$/;
const CSS_GRAPH_MAX_FILES = 200;
const CSS_GRAPH_MAX_DEPTH = 12;

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function resolveCssImport(spec: string, fromFile: string, targetDir: string, requireFromTarget: NodeRequire): Promise<string | null> {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const resolved = path.resolve(path.dirname(fromFile), spec);
    if (await exists(resolved)) return resolved;
    return resolved.endsWith(".css") ? null : ((await exists(`${resolved}.css`)) ? `${resolved}.css` : null);
  }
  if (spec.startsWith("@/")) {
    const withoutAlias = spec.slice(2);
    for (const root of [path.join(targetDir, "src"), targetDir]) {
      const resolved = path.join(root, withoutAlias);
      if (await exists(resolved)) return resolved;
      if (!resolved.endsWith(".css") && await exists(`${resolved}.css`)) return `${resolved}.css`;
    }
    return null;
  }
  if (spec.startsWith("http:") || spec.startsWith("https:")) return null;
  try {
    return requireFromTarget.resolve(spec);
  } catch {
    return resolveWorkspacePackageSpecifier(spec, path.dirname(fromFile));
  }
}

function cssImportsFromSource(source: string): string[] {
  const specs: string[] = [];
  for (const re of [CSS_IMPORT_RE, CSS_REQUIRE_RE]) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) specs.push(match[1]!);
  }
  return specs;
}

function isSelfReferentialVar(decl: CssVarDecl): boolean {
  return new RegExp(`^\\s*var\\(\\s*${decl.name}\\s*(?:,\\s*[^)]*)?\\)(?:\\s*,[\\s\\S]*)?\\s*$`).test(decl.value);
}

function cssImportsFromCss(source: string): Array<{ spec: string; fromUrl: boolean }> {
  const specs: Array<{ spec: string; fromUrl: boolean }> = [];
  CSS_AT_IMPORT_RE.lastIndex = 0;
  for (const match of source.matchAll(CSS_AT_IMPORT_RE)) {
    const spec = match[2] ?? match[3] ?? match[4];
    if (!spec || spec === "tailwindcss" || spec.startsWith("http:") || spec.startsWith("https:")) continue;
    specs.push({ spec, fromUrl: Boolean(match[1]) });
  }
  return specs;
}

async function collectCssGraph(
  roots: string[],
  targetDir: string,
  requireFromTarget: NodeRequire,
): Promise<string[]> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = async (file: string | null, depth: number): Promise<void> => {
    if (!file || seen.has(file) || depth > CSS_GRAPH_MAX_DEPTH || ordered.length >= CSS_GRAPH_MAX_FILES) return;
    seen.add(file);
    const css = await fs.readFile(file, "utf8").catch(() => "");
    for (const { spec, fromUrl } of cssImportsFromCss(css)) {
      // Local url(...) imports are often assets or prose stylesheets; package
      // url imports still carry token sheets in some monorepos.
      if (fromUrl && (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/"))) continue;
      await visit(await resolveCssImport(spec, file, targetDir, requireFromTarget), depth + 1);
    }
    ordered.push(file);
  };
  for (const root of roots) await visit(root, 0);
  return ordered;
}

async function collectCssFiles(targetDir: string): Promise<{ selected: string[]; all: string[] }> {
  const requireFromTarget = createRequire(path.join(targetDir, "package.json"));
  const sourceFiles = await walk(targetDir, (rel) => SOURCE_WITH_CSS_IMPORTS.test(rel), 2_000);
  const detectedCssFiles = await walk(targetDir, (rel) => rel.endsWith(".css"), 2_000);
  const directEntryFiles = await Promise.all(
    ENTRY_FILE_CANDIDATES.map(async (candidate) => {
      const file = path.join(targetDir, candidate);
      return await exists(file) ? file : null;
    }),
  );
  const entryFiles = new Set([
    ...directEntryFiles.filter((file): file is string => Boolean(file)),
    ...sourceFiles.filter((file) => ENTRY_SOURCE_FILE.test(path.relative(targetDir, file))),
  ]);
  const filesToScan = [...new Set([...entryFiles, ...sourceFiles])];
  const entryRoots: string[] = [];
  const blindRoots: string[] = [];
  const add = (file: string | null) => {
    if (file && !blindRoots.includes(file)) blindRoots.push(file);
  };

  for (const sourceFile of filesToScan) {
    const source = await fs.readFile(sourceFile, "utf8").catch(() => "");
    const resolved = await Promise.all(cssImportsFromSource(source).map((spec) => resolveCssImport(spec, sourceFile, targetDir, requireFromTarget)));
    if (entryFiles.has(sourceFile)) {
      for (const cssFile of resolved) if (cssFile && !entryRoots.includes(cssFile)) entryRoots.push(cssFile);
    }
    for (const cssFile of resolved) add(cssFile);
  }
  for (const cssFile of detectedCssFiles) add(cssFile);
  const entryGraph = await collectCssGraph(entryRoots, targetDir, requireFromTarget);
  const blindGraph = await collectCssGraph(blindRoots, targetDir, requireFromTarget);
  return { selected: entryGraph.length > 0 ? entryGraph : blindGraph, all: blindGraph };
}

/**
 * Muted-text inference of last resort: when no CSS variable fills the slot,
 * the app's dominant `text-<neutral>-<400..600>` Tailwind utility is its de
 * facto muted-text token (formbricks styles secondary text with
 * text-slate-500 in ~200 files; vercel/commerce with text-neutral-500).
 * Bounded scan, strict majority — ambiguous usage infers nothing.
 */
const MUTED_UTILITY = /(?<![\w:-])text-(slate|gray|zinc|neutral|stone)-(400|500|600)\b/g;

const ACCENT_BG_UTILITY = /(?<![\w:-])bg-([a-z][a-z0-9-]*)\b/g;
const RADIUS_UTILITY = /(?<![\w:-])rounded-(sm|md|lg|xl|2xl|3xl)(?![\w-])/g;
const SMALL_TEXT_UTILITY = /(?<![\w:-])text-(xs|sm)\b|(?<![\w:-])text-\[((?:\d+|\d*\.\d+))px\]/g;
const LARGE_TEXT_UTILITY = /(?<![\w:-])text-(base|lg)\b|(?<![\w:-])text-\[((?:\d+|\d*\.\d+))px\]/g;
const COMPACT_HEIGHT_UTILITY = /(?<![\w:-])h-(6|7|8)\b/g;
const COMFORTABLE_HEIGHT_UTILITY = /(?<![\w:-])h-(10|11|12)\b/g;
const MOTION_UTILITY = /(?<![\w:-])(?:transition(?:-[\w-]+)?|animate-[\w-]+)\b/g;
const NON_ACCENT_BG = /^(?:bg|background|surface|card|panel|popover|hover|muted|border|line|transparent|current|inherit|white|gray|grey|slate|stone|zinc|neutral|status|success|warning|error|danger|destructive|positive|negative|pos|neg)(?:-|$)/;
const RADIUS_VALUES: Record<string, string> = {
  sm: "2px",
  md: "6px",
  lg: "8px",
  xl: "12px",
  "2xl": "16px",
  "3xl": "24px",
};

interface SourceInferences {
  accent?: InferredSlotValue;
  mutedText?: InferredSlotValue;
  radius?: InferredSlotValue;
  density?: InferredSlotValue;
  motion?: InferredSlotValue;
}

function hasDisablingReducedMotionRule(source: string): boolean {
  const media = /@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)\s*\{/gi;
  for (const match of source.matchAll(media)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
    }
    const block = source.slice(start, end - 1);
    if (/(?:animation|transition)(?:-duration)?\s*:\s*none(?:\s*!important)?\s*[;}]/i.test(block)) return true;
    if (/scroll-behavior\s*:\s*auto(?:\s*!important)?\s*[;}]/i.test(block)) return true;
    for (const duration of block.matchAll(/(?:animation|transition)-duration\s*:\s*(\d*\.?\d+)(ms|s)(?:\s*!important)?\s*[;}]/gi)) {
      const milliseconds = Number(duration[1]) * (duration[2]!.toLowerCase() === "s" ? 1_000 : 1);
      if (milliseconds <= 1) return true;
    }
  }
  return false;
}

function dominant(
  counts: Map<string, number>,
  minimum: number,
  lead = 1.5,
): [string, number] | undefined {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [winner, runnerUp] = ranked;
  if (!winner || winner[1] < minimum || (runnerUp && winner[1] < runnerUp[1] * lead)) return undefined;
  return winner;
}

/**
 * Source-level fallbacks are deliberately high-signal: a utility must be used
 * repeatedly and dominate alternatives. A one-off class never becomes a host
 * theme token, which keeps extraction fail-closed on mixed design systems.
 */
async function inferSlotsFromUtilities(targetDir: string, vars: CssVarDecl[]): Promise<SourceInferences> {
  const files = await walk(targetDir, (rel) => /\.(tsx|jsx)$/.test(rel), 2_000);
  const cssFiles = await walk(targetDir, (rel) => rel.endsWith(".css"), 2_000);
  const accentCounts = new Map<string, number>();
  const mutedCounts = new Map<string, number>();
  const radiusCounts = new Map<string, number>();
  let compact = 0;
  let comfortable = 0;
  let motion = 0;

  for (const file of files) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    for (const match of source.matchAll(ACCENT_BG_UTILITY)) {
      const token = match[1]!;
      if (!NON_ACCENT_BG.test(token)) accentCounts.set(token, (accentCounts.get(token) ?? 0) + 1);
    }
    for (const match of source.matchAll(MUTED_UTILITY)) {
      const token = `${match[1]}-${match[2]}`;
      mutedCounts.set(token, (mutedCounts.get(token) ?? 0) + 1);
    }
    for (const match of source.matchAll(RADIUS_UTILITY)) {
      const token = match[1]!;
      radiusCounts.set(token, (radiusCounts.get(token) ?? 0) + 1);
    }
    for (const match of source.matchAll(SMALL_TEXT_UTILITY)) {
      const arbitrary = match[2] ? Number(match[2]) : null;
      if (arbitrary === null || arbitrary <= 13.5) compact += 1;
    }
    for (const match of source.matchAll(LARGE_TEXT_UTILITY)) {
      const arbitrary = match[2] ? Number(match[2]) : null;
      if (arbitrary === null || arbitrary >= 16) comfortable += 1;
    }
    compact += [...source.matchAll(COMPACT_HEIGHT_UTILITY)].length;
    comfortable += [...source.matchAll(COMFORTABLE_HEIGHT_UTILITY)].length;
    motion += [...source.matchAll(MOTION_UTILITY)].length;
  }

  const inferred: SourceInferences = {};
  const accent = dominant(accentCounts, 5);
  if (accent) {
    const decl = [...vars].reverse().find((value) => !value.darkScope && value.name === `--color-${accent[0]}`);
    const color = decl ? normalizeColorVar(decl.value, vars) : null;
    if (color) inferred.accent = { value: color, source: `bg-${accent[0]} ×${accent[1]}` };
  }
  const muted = dominant(mutedCounts, 5);
  if (muted) {
    const [family, step] = muted[0].split("-") as [string, string];
    const value = TAILWIND_NEUTRAL_COLORS[family]?.[step];
    if (value) inferred.mutedText = { value, source: `text-${muted[0]} ×${muted[1]}` };
  }
  const radius = dominant(radiusCounts, 5);
  if (radius) inferred.radius = { value: RADIUS_VALUES[radius[0]]!, source: `rounded-${radius[0]} ×${radius[1]}` };

  if (compact >= 12 && compact >= comfortable * 1.5) {
    inferred.density = { value: "compact", source: `compact type/spacing utilities ×${compact}` };
  } else if (comfortable >= 12 && comfortable >= compact * 1.5) {
    inferred.density = { value: "comfortable", source: `comfortable type/spacing utilities ×${comfortable}` };
  }
  let reducedMotionFile: string | undefined;
  for (const file of cssFiles) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (hasDisablingReducedMotionRule(source)) {
      reducedMotionFile = path.relative(targetDir, file) || path.basename(file);
      break;
    }
  }
  if (reducedMotionFile) {
    inferred.motion = { value: "reduced", source: `prefers-reduced-motion in ${reducedMotionFile}` };
  } else if (motion >= 5) {
    inferred.motion = { value: "full", source: `transition/animation utilities ×${motion}` };
  }
  return inferred;
}

export async function extractTheme(
  targetDir: string,
): Promise<ThemeSummary> {
  const vars: CssVarDecl[] = [];
  const errors: string[] = [];

  const cssFiles = await collectCssFiles(targetDir);
  for (const cssFile of cssFiles.selected) {
    const css = await fs.readFile(cssFile, "utf8");
    vars.push(...parseCssVars(css, path.relative(targetDir, cssFile)));
  }
  vars.push(...await collectNextLayoutVars(targetDir));
  // next/font injects --font-* vars at runtime; recover them from source so
  // font var() chains resolve to the actual family. An explicit CSS
  // declaration of the same variable stays authoritative.
  const cssByName = new Map(vars.filter((v) => !v.darkScope).map((v) => [v.name, v]));
  vars.push(...(await collectNextFontVars(targetDir)).filter((v) => {
    if (!v.synthetic) return true;
    const declared = cssByName.get(v.name);
    return !declared || isSelfReferentialVar(declared);
  }));

  // Inference fallbacks fill only slots no declared variable claims — map
  // first, and pay the source scan only when the slot actually defaulted.
  let result = mapVarsToBrand(vars);
  const utilitySlots = ["accent", "radius", "density", "motion"] satisfies Array<keyof ThemeSlotValues>;
  const needsUtilityInference = utilitySlots.some((slot) => result.defaulted.includes(slot))
    || /(?:card|popover|modal|dialog)/.test(result.matched.radius ?? "");
  if (needsUtilityInference || result.defaulted.includes("mutedText")) {
    const inferred = await inferSlotsFromUtilities(targetDir, vars);
    result = mapVarsToBrand(vars, inferred);
  }
  return { ...result, errors, varCount: vars.length };
}
