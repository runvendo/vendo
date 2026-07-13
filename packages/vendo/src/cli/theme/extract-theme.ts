import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { collectNextFontVars, collectNextLayoutVars, TAILWIND_NEUTRAL_COLORS } from "./next-fonts.js";
import { mapVarsToBrand, type BrandMappingResult, type InferredSlotValue } from "./map-to-brand.js";
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
const ENTRY_SOURCE_CANDIDATES = [
  "app/layout.tsx",
  "app/layout.jsx",
  "app/layout.ts",
  "app/layout.js",
  "src/app/layout.tsx",
  "src/app/layout.jsx",
  "src/app/layout.ts",
  "src/app/layout.js",
  "pages/_app.tsx",
  "pages/_app.jsx",
  "pages/_app.ts",
  "pages/_app.js",
  "src/pages/_app.tsx",
  "src/pages/_app.jsx",
  "src/pages/_app.ts",
  "src/pages/_app.js",
];
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
    ENTRY_SOURCE_CANDIDATES.map(async (candidate) => {
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

async function inferMutedTextFromUtilities(targetDir: string): Promise<InferredSlotValue | undefined> {
  const files = await walk(targetDir, (rel) => /\.(tsx|jsx)$/.test(rel), 2_000);
  const counts = new Map<string, number>();
  for (const file of files) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    for (const match of source.matchAll(MUTED_UTILITY)) {
      counts.set(`${match[1]}-${match[2]}`, (counts.get(`${match[1]}-${match[2]}`) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [winner, runnerUp] = ranked;
  // Require real adoption and a clear winner, not a coin flip between scales.
  if (!winner || winner[1] < 5 || (runnerUp && winner[1] < runnerUp[1] * 1.5)) return undefined;
  const [family, step] = winner[0].split("-") as [string, string];
  const value = TAILWIND_NEUTRAL_COLORS[family]?.[step];
  return value ? { value, source: `text-${winner[0]} ×${winner[1]}` } : undefined;
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
  if (result.defaulted.includes("mutedText")) {
    const mutedText = await inferMutedTextFromUtilities(targetDir);
    if (mutedText) result = mapVarsToBrand(vars, { mutedText });
  }
  return { ...result, errors, varCount: vars.length };
}
