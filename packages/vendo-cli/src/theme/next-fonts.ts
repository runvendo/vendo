import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "../fsx.js";
import type { CssVarDecl } from "./css-vars.js";

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
      out.push({
        name: variable[1],
        value: family,
        file,
        darkScope: false,
        synthetic: true,
      });
    }
  }
  const geistRe = /import\s*\{([^}]+)\}\s*from\s*["']geist\/font\/(sans|mono)["']/g;
  for (const im of src.matchAll(geistRe)) {
    const kind = im[2];
    for (const spec of im[1]!.split(",")) {
      const [exportName] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!exportName) continue;
      if (kind === "sans" && exportName === "GeistSans") {
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

const TAILWIND_NEUTRAL_COLORS: Record<string, Record<string, string>> = {
  slate: { "50": "#f8fafc", "100": "#f1f5f9", "200": "#e2e8f0", "300": "#cbd5e1", "400": "#94a3b8", "500": "#64748b", "600": "#475569", "700": "#334155", "800": "#1e293b", "900": "#0f172a", "950": "#020617" },
  gray: { "50": "#f9fafb", "100": "#f3f4f6", "200": "#e5e7eb", "300": "#d1d5db", "400": "#9ca3af", "500": "#6b7280", "600": "#4b5563", "700": "#374151", "800": "#1f2937", "900": "#111827", "950": "#030712" },
  zinc: { "50": "#fafafa", "100": "#f4f4f5", "200": "#e4e4e7", "300": "#d4d4d8", "400": "#a1a1aa", "500": "#71717a", "600": "#52525b", "700": "#3f3f46", "800": "#27272a", "900": "#18181b", "950": "#09090b" },
  neutral: { "50": "#fafafa", "100": "#f5f5f5", "200": "#e5e5e5", "300": "#d4d4d4", "400": "#a3a3a3", "500": "#737373", "600": "#525252", "700": "#404040", "800": "#262626", "900": "#171717", "950": "#0a0a0a" },
  stone: { "50": "#fafaf9", "100": "#f5f5f4", "200": "#e7e5e4", "300": "#d6d3d1", "400": "#a8a29e", "500": "#78716c", "600": "#57534e", "700": "#44403c", "800": "#292524", "900": "#1c1917", "950": "#0c0a09" },
};

export function parseNextLayoutVars(source: string, file: string): CssVarDecl[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: CssVarDecl[] = [];
  const bgRe = /(?<![\w:-])bg-(white|black|(?:slate|gray|zinc|neutral|stone)-(?:50|100|200|300|400|500|600|700|800|900|950))\b/g;
  for (const match of src.matchAll(bgRe)) {
    const token = match[1]!;
    const value = token === "white" ? "#ffffff"
      : token === "black" ? "#000000"
      : (() => {
          const [scale, step] = token.split("-");
          return scale && step ? TAILWIND_NEUTRAL_COLORS[scale]?.[step] : undefined;
        })();
    if (value) {
      out.push({ name: "--background", value, file, darkScope: false });
      break;
    }
  }
  return out;
}

/** Where next/font loaders conventionally live: root layouts and font modules.
 * A whole-tree scan would hit walk()'s file cap before the layout on large
 * repos and pay hundreds of reads on the init path. */
const FONT_SOURCE_FILE = /(^|\/)(layout|_app|_document|fonts?)\.(tsx|jsx|ts|js|mjs)$/;

export async function collectNextFontVars(targetDir: string): Promise<CssVarDecl[]> {
  const files = await walk(targetDir, (p) => FONT_SOURCE_FILE.test(p), 500);
  const out: CssVarDecl[] = [];
  for (const f of files) {
    const src = await fs.readFile(f, "utf8").catch(() => null);
    if (src?.includes("next/font/google") || src?.includes("geist/font/")) {
      out.push(...parseNextFontVars(src, path.relative(targetDir, f)));
    }
  }
  return out;
}

export async function collectNextLayoutVars(targetDir: string): Promise<CssVarDecl[]> {
  const files = await walk(targetDir, (p) => FONT_SOURCE_FILE.test(p), 500);
  const out: CssVarDecl[] = [];
  for (const f of files) {
    const src = await fs.readFile(f, "utf8").catch(() => null);
    if (src) out.push(...parseNextLayoutVars(src, path.relative(targetDir, f)));
  }
  return out;
}
