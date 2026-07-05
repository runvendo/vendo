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
      const call = src.match(new RegExp(`\\b${local}\\s*\\(\\s*\\{([^}]*)\\}`));
      const variable = call?.[1]?.match(/variable:\s*["'](--[\w-]+)["']/);
      if (!variable?.[1]) continue;
      out.push({
        name: variable[1],
        value: `"${exportName.replace(/_/g, " ")}"`,
        file,
        darkScope: false,
        synthetic: true,
      });
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
    if (src?.includes("next/font/google")) out.push(...parseNextFontVars(src, path.relative(targetDir, f)));
  }
  return out;
}
