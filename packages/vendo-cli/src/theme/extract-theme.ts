import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { FrameworkInfo } from "../detect.js";
import { walk, writeGenerated } from "../fsx.js";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { collectNextFontVars, collectNextLayoutVars } from "./next-fonts.js";
import { extractTailwindVars } from "./tailwind-config.js";
import { mapVarsToBrand, type BrandMappingResult } from "./map-to-brand.js";

export interface ThemeSummary extends Omit<BrandMappingResult, "brand"> {
  written: boolean;
  errors: string[];
  varCount: number;
}

const SOURCE_WITH_CSS_IMPORTS = /\.(tsx|jsx|ts|js|mjs|cjs)$/;
const CSS_IMPORT_RE = /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+\.css)["']/g;
const CSS_REQUIRE_RE = /\brequire\(\s*["']([^"']+\.css)["']\s*\)/g;

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function resolveCssImport(spec: string, fromFile: string, targetDir: string, requireFromTarget: NodeRequire): Promise<string | null> {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const resolved = path.resolve(path.dirname(fromFile), spec);
    return (await exists(resolved)) ? resolved : null;
  }
  if (spec.startsWith("@/")) {
    const withoutAlias = spec.slice(2);
    for (const root of [path.join(targetDir, "src"), targetDir]) {
      const resolved = path.join(root, withoutAlias);
      if (await exists(resolved)) return resolved;
    }
    return null;
  }
  try {
    return requireFromTarget.resolve(spec);
  } catch {
    return null;
  }
}

async function collectCssFiles(targetDir: string, detectedCssFiles: string[]): Promise<string[]> {
  const requireFromTarget = createRequire(path.join(targetDir, "package.json"));
  const sourceFiles = await walk(targetDir, (rel) => SOURCE_WITH_CSS_IMPORTS.test(rel), 2_000);
  const ordered: string[] = [];
  const add = (file: string | null) => {
    if (file && !ordered.includes(file)) ordered.push(file);
  };

  for (const sourceFile of sourceFiles) {
    const source = await fs.readFile(sourceFile, "utf8").catch(() => "");
    for (const re of [CSS_IMPORT_RE, CSS_REQUIRE_RE]) {
      re.lastIndex = 0;
      for (const match of source.matchAll(re)) {
        add(await resolveCssImport(match[1]!, sourceFile, targetDir, requireFromTarget));
      }
    }
  }
  for (const cssFile of detectedCssFiles) add(cssFile);
  return ordered;
}

export async function extractTheme(
  targetDir: string,
  info: FrameworkInfo,
  opts: { force: boolean },
): Promise<ThemeSummary> {
  const vars: CssVarDecl[] = [];
  const errors: string[] = [];

  const cssFiles = await collectCssFiles(targetDir, info.cssFiles);
  for (const cssFile of cssFiles) {
    const css = await fs.readFile(cssFile, "utf8");
    vars.push(...parseCssVars(css, path.relative(targetDir, cssFile)));
  }
  const cssDeclared = new Set(vars.map((v) => v.name));
  if (info.tailwindConfigPath) {
    const { vars: twVars, error } = await extractTailwindVars(info.tailwindConfigPath);
    vars.push(...twVars);
    if (error) errors.push(error);
  }
  if (info.framework === "next") {
    vars.push(...await collectNextLayoutVars(targetDir));
  }
  // next/font injects --font-* vars at runtime; recover them from source so
  // font var() chains resolve to the actual family. An explicit CSS
  // declaration of the same variable stays authoritative.
  if (info.framework === "next") {
    vars.push(...(await collectNextFontVars(targetDir)).filter((v) => !cssDeclared.has(v.name)));
  }

  const result = mapVarsToBrand(vars);
  let written = false;
  if (result.brand) {
    await writeGenerated(
      path.join(targetDir, ".vendo/theme.json"),
      JSON.stringify(result.brand, null, 2) + "\n",
      opts,
    );
    written = true;
  } else {
    errors.push("could not assemble a valid BrandTokens object — write .vendo/theme.json by hand");
  }
  const { brand: _brand, ...rest } = result;
  return { ...rest, written, errors, varCount: vars.length };
}
