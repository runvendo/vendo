import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "../fsx.js";
import type { CssVarDecl } from "./css-vars.js";

const TAILWIND_SANS_FALLBACK = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji";
const ENTRY_LAYOUT_CANDIDATES = [
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
  "pages/_document.tsx",
  "pages/_document.jsx",
  "pages/_document.ts",
  "pages/_document.js",
  "src/pages/_document.tsx",
  "src/pages/_document.jsx",
  "src/pages/_document.ts",
  "src/pages/_document.js",
];

function titleCaseFontSourceSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * next/font injects `--font-*` variables at runtime (className on <html>), so
 * they never appear in CSS. Recover them from source: a next/font/google
 * export name IS the family name (underscores for spaces). next/font/local is
 * skipped — the family is not derivable from source, and guessing would break
 * the fail-closed contract. Declarations are marked synthetic: they resolve
 * var() chains but are never picked directly for a slot.
 */
export function parseNextFontVars(source: string, file: string): CssVarDecl[] {
  // Strip comments so stale commented-out loader calls can't win.
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: CssVarDecl[] = [];
  const fontSourceRe = /import\s+["']@fontsource(?:-variable)?\/([^"']+)["']/g;
  for (const match of src.matchAll(fontSourceRe)) {
    const isVariable = match[0]!.includes("@fontsource-variable/");
    const family = `${titleCaseFontSourceSlug(match[1]!)}${isVariable ? " Variable" : ""}`;
    out.push({
      name: "--font-family",
      value: `${family}, ${TAILWIND_SANS_FALLBACK}`,
      file,
      darkScope: false,
    });
  }
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["']next\/font\/google["']/g;
  for (const im of src.matchAll(importRe)) {
    for (const spec of im[1]!.split(",")) {
      const [exportName, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!exportName || !/^[A-Za-z_]\w*$/.test(exportName)) continue;
      if (alias && !/^[A-Za-z_]\w*$/.test(alias)) continue; // unsafe to embed in a RegExp
      const local = alias ?? exportName;
      // First call of the loader with an options object; options never nest braces.
      const assignment = src.match(new RegExp(`\\b(export\\s+)?(?:const|let|var)\\s+([A-Za-z_]\\w*)\\s*=\\s*${local}\\s*\\(\\s*\\{([^}]*)\\}`));
      const options = assignment?.[3] ?? src.match(new RegExp(`\\b${local}\\s*\\(\\s*\\{([^}]*)\\}`))?.[1];
      const variable = options?.match(/variable:\s*["'](--[\w-]+)["']/);
      const family = exportName.replace(/_/g, " ");
      if (!variable?.[1]) {
        const exported = Boolean(assignment?.[1]);
        const instance = assignment?.[2];
        if (exported || (instance && new RegExp(`\\b${instance}\\.className\\b`).test(src))) {
          out.push({
            name: "--font-family",
            value: `${family}, sans-serif`,
            file,
            darkScope: false,
          });
        }
        continue;
      }
      const instance = assignment?.[2];
      out.push({
        name: variable[1],
        value: family,
        file,
        darkScope: false,
        synthetic: true,
      });
      if (instance) {
        const inlineVar = src.match(new RegExp(`${escapeRegExp(variable[1])}\\s*:\\s*\\$\\{\\s*${instance}\\.style\\.fontFamily[^}]*\\}\\s*,\\s*([^;\\n\`]+)`));
        const fallback = inlineVar?.[1]?.trim();
        if (fallback) {
          out.push({
            name: variable[1],
            value: `${family}, ${fallback}`,
            file,
            darkScope: false,
          });
        }
      }
    }
  }
  const geistRe = /import\s*\{([^}]+)\}\s*from\s*["']geist\/font\/(sans|mono)["']/g;
  for (const im of src.matchAll(geistRe)) {
    const kind = im[2];
    for (const spec of im[1]!.split(",")) {
      const [exportName] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!exportName) continue;
      if (kind === "sans" && exportName === "GeistSans") {
        if (new RegExp(`\\b${exportName}\\.(?:variable|className)\\b`).test(src)) {
          out.push({
            name: "--font-family",
            value: "Geist Sans, ui-sans-serif, system-ui, sans-serif",
            file,
            darkScope: false,
          });
        }
        out.push({
          name: "--font-geist-sans",
          value: "Geist Sans",
          file,
          darkScope: false,
          synthetic: true,
        });
      }
      if (kind === "mono" && exportName === "GeistMono") {
        out.push({
          name: "--font-geist-mono",
          value: "Geist Mono",
          file,
          darkScope: false,
          synthetic: true,
        });
      }
    }
  }
  return out;
}

export const TAILWIND_NEUTRAL_COLORS: Record<string, Record<string, string>> = {
  slate: { "50": "#f8fafc", "100": "#f1f5f9", "200": "#e2e8f0", "300": "#cbd5e1", "400": "#94a3b8", "500": "#64748b", "600": "#475569", "700": "#334155", "800": "#1e293b", "900": "#0f172a", "950": "#020617" },
  gray: { "50": "#f9fafb", "100": "#f3f4f6", "200": "#e5e7eb", "300": "#d1d5db", "400": "#9ca3af", "500": "#6b7280", "600": "#4b5563", "700": "#374151", "800": "#1f2937", "900": "#111827", "950": "#030712" },
  zinc: { "50": "#fafafa", "100": "#f4f4f5", "200": "#e4e4e7", "300": "#d4d4d8", "400": "#a1a1aa", "500": "#71717a", "600": "#52525b", "700": "#3f3f46", "800": "#27272a", "900": "#18181b", "950": "#09090b" },
  neutral: { "50": "#fafafa", "100": "#f5f5f5", "200": "#e5e5e5", "300": "#d4d4d4", "400": "#a3a3a3", "500": "#737373", "600": "#525252", "700": "#404040", "800": "#262626", "900": "#171717", "950": "#0a0a0a" },
  stone: { "50": "#fafaf9", "100": "#f5f5f4", "200": "#e7e5e4", "300": "#d6d3d1", "400": "#a8a29e", "500": "#78716c", "600": "#57534e", "700": "#44403c", "800": "#292524", "900": "#1c1917", "950": "#0c0a09" },
};

function resolveTailwindColor(token: string): string | null {
  if (token === "white") return "#ffffff";
  if (token === "black") return "#000000";
  const [scale, step] = token.split("-");
  return scale && step ? (TAILWIND_NEUTRAL_COLORS[scale]?.[step] ?? null) : null;
}

function tokenBackedColorVar(prefix: string, token: string): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(token)) return null;
  if (["transparent", "current", "inherit"].includes(token)) return null;
  if (token.includes("/")) return null;
  return `var(--color-${token.replace(new RegExp(`^${prefix}-`), "")})`;
}

/** Non-color `text-*` / `bg-*` utilities that must never claim a color slot
 * (sizing, alignment, wrapping, background layout). Steps like `2xl` never
 * match the token regex ([a-z] first char), so only lowercase words appear. */
const NON_COLOR_TEXT_TOKENS = new Set([
  "xs", "sm", "base", "lg", "xl",
  "left", "center", "right", "justify", "start", "end",
  "wrap", "nowrap", "balance", "pretty", "clip", "ellipsis", "truncate",
]);
const NON_COLOR_BG_TOKENS = new Set([
  "auto", "cover", "contain", "fixed", "local", "scroll", "none",
  "top", "bottom", "left", "right", "center",
]);
const NON_COLOR_BG_PREFIXES = /^(?:gradient-|repeat|clip-|origin-|blend-|opacity-)/;

/**
 * The first raw Tailwind palette color among the matches wins; otherwise the
 * first plausible token-backed custom color (`bg-subtle` → var(--color-subtle)).
 * Scanning all matches keeps non-color utilities (`text-sm`, `bg-no-repeat`)
 * from shadowing the real color class that follows them.
 */
function pickColorToken(
  src: string,
  re: RegExp,
  prefix: string,
  isNonColor: (token: string) => boolean,
): string | null {
  let tokenBacked: string | null = null;
  for (const match of src.matchAll(re)) {
    const token = match[1]!;
    const raw = resolveTailwindColor(token);
    if (raw) return raw;
    if (tokenBacked === null && !isNonColor(token)) tokenBacked = tokenBackedColorVar(prefix, token);
  }
  return tokenBacked;
}

export function parseNextLayoutVars(source: string, file: string): CssVarDecl[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: CssVarDecl[] = [];
  const bgRe = /(?<![\w:-])bg-([a-z][a-z0-9-]*(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?)\b/g;
  const bg = pickColorToken(src, bgRe, "bg", (t) => NON_COLOR_BG_TOKENS.has(t) || NON_COLOR_BG_PREFIXES.test(t));
  if (bg) out.push({ name: "--background", value: bg, file, darkScope: false, inferred: true });
  const textRe = /(?<![\w:-])text-([a-z][a-z0-9-]*(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?)\b/g;
  const text = pickColorToken(src, textRe, "text", (t) => NON_COLOR_TEXT_TOKENS.has(t));
  if (text) out.push({ name: "--foreground", value: text, file, darkScope: false, inferred: true });
  return out;
}

/** Where next/font loaders conventionally live: root layouts and font modules.
 * A whole-tree scan would hit walk()'s file cap before the layout on large
 * repos and pay hundreds of reads on the init path. */
const FONT_SOURCE_FILE = /(^|\/)(layout|_app|_document|fonts?)\.(tsx|jsx|ts|js|mjs)$/;

async function collectEntryLayoutFiles(targetDir: string): Promise<string[]> {
  const files = await Promise.all(
    ENTRY_LAYOUT_CANDIDATES.map(async (candidate) => {
      const file = path.join(targetDir, candidate);
      return await exists(file) ? file : null;
    }),
  );
  return files.filter((file): file is string => Boolean(file));
}

export async function collectNextFontVars(targetDir: string): Promise<CssVarDecl[]> {
  const files = [...new Set([
    ...await collectEntryLayoutFiles(targetDir),
    ...await walk(targetDir, (p) => FONT_SOURCE_FILE.test(p), 500),
  ])];
  const out: CssVarDecl[] = [];
  for (const f of files) {
    const src = await fs.readFile(f, "utf8").catch(() => null);
    if (src?.includes("next/font/google") || src?.includes("geist/font/") || src?.includes("@fontsource")) {
      out.push(...parseNextFontVars(src, path.relative(targetDir, f)));
    }
  }
  return out;
}

export async function collectNextLayoutVars(targetDir: string): Promise<CssVarDecl[]> {
  const entryFiles = await collectEntryLayoutFiles(targetDir);
  const files = entryFiles.length > 0 ? entryFiles : await walk(targetDir, (p) => FONT_SOURCE_FILE.test(p), 500);
  const out: CssVarDecl[] = [];
  let entryOwnsDocument = false;
  for (const f of files) {
    const src = await fs.readFile(f, "utf8").catch(() => null);
    if (!src) continue;
    if (entryFiles.includes(f) && /<\s*(html|body)\b/.test(src)) entryOwnsDocument = true;
    out.push(...parseNextLayoutVars(src, path.relative(targetDir, f)));
  }
  if (entryFiles.length > 0 && out.length === 0 && !entryOwnsDocument) {
    const fallback = await walk(targetDir, (p) => FONT_SOURCE_FILE.test(p), 500);
    for (const f of fallback.filter((file) => !entryFiles.includes(file))) {
      const src = await fs.readFile(f, "utf8").catch(() => null);
      if (src) out.push(...parseNextLayoutVars(src, path.relative(targetDir, f)));
    }
  }
  return out;
}
