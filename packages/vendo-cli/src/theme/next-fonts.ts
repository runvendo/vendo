import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "../fsx.js";
import type { CssVarDecl } from "./css-vars.js";

/**
 * next/font injects `--font-*` variables at runtime (className on <html>), so
 * they never appear in CSS. Recover them from source: a next/font/google
 * export name IS the family name (underscores for spaces). next/font/local is
 * skipped — the family is not derivable from source, and guessing would break
 * the fail-closed contract.
 */
export function parseNextFontVars(source: string, file: string): CssVarDecl[] {
  const out: CssVarDecl[] = [];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["']next\/font\/google["']/g;
  for (const im of source.matchAll(importRe)) {
    for (const spec of im[1]!.split(",")) {
      const [exportName, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!exportName || !/^[A-Za-z_]\w*$/.test(exportName)) continue;
      const local = alias && /^[A-Za-z_]\w*$/.test(alias) ? alias : exportName;
      // First call of the loader with an options object; options never nest braces.
      const call = source.match(new RegExp(`\\b${local}\\s*\\(\\s*\\{([^}]*)\\}`));
      const variable = call?.[1]?.match(/variable:\s*["'](--[\w-]+)["']/);
      if (!variable?.[1]) continue;
      out.push({ name: variable[1], value: `"${exportName.replace(/_/g, " ")}"`, file, darkScope: false });
    }
  }
  return out;
}

const SOURCE_FILE = /\.(tsx|jsx|ts|js|mjs)$/;

export async function collectNextFontVars(targetDir: string): Promise<CssVarDecl[]> {
  const files = await walk(targetDir, (p) => SOURCE_FILE.test(p), 500);
  const out: CssVarDecl[] = [];
  for (const f of files) {
    const src = await fs.readFile(f, "utf8").catch(() => null);
    if (src?.includes("next/font/google")) out.push(...parseNextFontVars(src, path.relative(targetDir, f)));
  }
  return out;
}
