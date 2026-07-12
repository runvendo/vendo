import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, stop } from "esbuild";
import type { CssVarDecl } from "./css-vars.js";
import { resolveWorkspacePackageSpecifier } from "./workspace-resolve.js";

const SOURCE_SANS_FALLBACK = ["ui-sans-serif", "system-ui", "sans-serif"];
const SOURCE_MONO_FALLBACK = ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"];
const TAILWIND_EMOJI_FONT_FALLBACKS = new Set([
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
]);
const SOURCE_IMPORT_RE = /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/g;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs"];

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(() => true, () => false);
}

async function resolveSourceImport(spec: string, fromFile: string): Promise<string | null> {
  if (spec.startsWith("tailwindcss/")) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = base.endsWith(ext) ? base : `${base}${ext}`;
      if (await exists(candidate)) return candidate;
    }
    return null;
  }
  try {
    return createRequire(fromFile).resolve(spec);
  } catch {
    return resolveWorkspacePackageSpecifier(spec, path.dirname(fromFile));
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function objectBodies(source: string, key: string): string[] {
  const bodies: string[] = [];
  const re = new RegExp(`\\b${key}\\s*:\\s*\\{`, "g");
  for (const match of source.matchAll(re)) {
    const start = (match.index ?? 0) + match[0]!.lastIndexOf("{");
    let depth = 0;
    let quote: string | null = null;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]!;
      const prev = index > 0 ? source[index - 1] : "";
      if (quote) {
        if (char === quote && prev !== "\\") quote = null;
        continue;
      }
      if (char === "\"" || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(start + 1, index));
          break;
        }
      }
    }
  }
  return bodies;
}

function parseFontArray(body: string): string[] {
  const values: string[] = [];
  const tokenRe = /(["'])(.*?)\1|\.\.\.\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  for (const match of body.matchAll(tokenRe)) {
    if (match[2]) {
      values.push(match[2]);
      continue;
    }
    const spread = match[3];
    if (spread?.endsWith(".sans")) values.push(...SOURCE_SANS_FALLBACK);
    else if (spread?.endsWith(".mono")) values.push(...SOURCE_MONO_FALLBACK);
  }
  return withoutTailwindEmojiFallbacks(values);
}

function withoutTailwindEmojiFallbacks(values: string[]): string[] {
  return values.filter((value) => {
    const normalized = value.replace(/^["']|["']$/g, "").toLowerCase();
    return !TAILWIND_EMOJI_FONT_FALLBACKS.has(normalized);
  });
}

function parseSourceFontFamilyVars(source: string, file: string): CssVarDecl[] {
  const out: CssVarDecl[] = [];
  for (const body of objectBodies(stripComments(source), "fontFamily")) {
    const propRe = /(?:^|,|\n)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*\[([^\]]+)\]/g;
    for (const match of body.matchAll(propRe)) {
      const rawName = match[1] ?? match[2] ?? match[3];
      const arrayBody = match[4];
      if (!rawName || !arrayBody) continue;
      const value = parseFontArray(arrayBody).join(", ");
      if (!value) continue;
      const name = rawName === "DEFAULT" ? "--font-family" : `--font-${rawName}`;
      out.push({ name, value, file, darkScope: false });
    }
  }
  return out;
}

async function extractSourceTailwindVars(configPath: string, seen = new Set<string>(), depth = 0): Promise<CssVarDecl[]> {
  if (seen.has(configPath) || depth > 4) return [];
  seen.add(configPath);
  const source = await readFile(configPath, "utf8").catch(() => null);
  if (!source) return [];
  const vars: CssVarDecl[] = [];
  for (const match of source.matchAll(SOURCE_IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    const resolved = await resolveSourceImport(spec, configPath);
    if (resolved) vars.push(...await extractSourceTailwindVars(resolved, seen, depth + 1));
  }
  vars.push(...parseSourceFontFamilyVars(source, configPath));
  return vars;
}

/**
 * Extract theme tokens from a Tailwind v3 config by importing it (dev-time,
 * the developer's own code). Values are normalised into the same CssVarDecl
 * shape the CSS scanner produces so one mapping layer serves both. Configs are
 * bundled through esbuild first so .ts files and mixed ESM/CommonJS configs
 * load the same way real Tailwind projects write them.
 */
export async function extractTailwindVars(
  configPath: string,
): Promise<{ vars: CssVarDecl[]; error: string | null }> {
  let theme: Record<string, unknown> | null = null;
  let tempDir: string | null = null;
  let error: string | null = null;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "vendo-tailwind-"));
    const bundled = path.join(tempDir, "tailwind.config.cjs");
    await build({
      entryPoints: [configPath],
      outfile: bundled,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      absWorkingDir: path.dirname(configPath),
      logLevel: "silent",
    });
    const mod = createRequire(bundled)(bundled);
    const cfg = (mod.default ?? mod) as { theme?: { extend?: Record<string, unknown> } & Record<string, unknown> };
    theme = { ...(cfg.theme ?? {}), ...((cfg.theme?.extend as Record<string, unknown>) ?? {}) };
  } catch (err) {
    error = `could not load ${configPath}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    stop();
  }

  const vars: CssVarDecl[] = [];
  const file = configPath;

  const colors = theme?.["colors"] as Record<string, unknown> | undefined;
  if (colors) {
    for (const [name, v] of Object.entries(colors)) {
      const value =
        typeof v === "string" ? v
        : v && typeof v === "object" ? ((v as Record<string, unknown>)["DEFAULT"] ?? (v as Record<string, unknown>)["500"]) : undefined;
      if (typeof value === "string") vars.push({ name: `--color-${name}`, value, file, darkScope: false });
    }
  }
  const radius = theme?.["borderRadius"] as Record<string, unknown> | undefined;
  if (radius) {
    for (const [name, v] of Object.entries(radius)) {
      if (typeof v === "string") vars.push({ name: name === "DEFAULT" ? "--radius" : `--radius-${name}`, value: v, file, darkScope: false });
    }
  }
  const fonts = theme?.["fontFamily"] as Record<string, unknown> | undefined;
  if (fonts) {
    for (const [name, v] of Object.entries(fonts)) {
      const value = Array.isArray(v) ? withoutTailwindEmojiFallbacks(v.map(String)).join(", ") : typeof v === "string" ? v : undefined;
      if (value) vars.push({ name: `--font-${name}`, value, file, darkScope: false });
    }
  }
  // Source-level fontFamily parsing is the fallback for configs whose imports
  // can't be executed (workspace presets outside the app's node_modules). An
  // executed config stays authoritative — parsing its source too would let a
  // duplicate, unresolved declaration shadow the executed value on ties.
  if (!vars.some((v) => v.name.startsWith("--font-"))) {
    vars.push(...await extractSourceTailwindVars(configPath));
  }
  return { vars, error };
}
