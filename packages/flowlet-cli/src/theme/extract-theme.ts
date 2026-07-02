import { promises as fs } from "node:fs";
import path from "node:path";
import type { FrameworkInfo } from "../detect.js";
import { parseCssVars, type CssVarDecl } from "./css-vars.js";
import { extractTailwindVars } from "./tailwind-config.js";
import { mapVarsToBrand, type BrandMappingResult } from "./map-to-brand.js";
import { writeGenerated } from "../fsx.js";

export interface ThemeSummary extends Omit<BrandMappingResult, "brand"> {
  written: boolean;
  errors: string[];
  varCount: number;
}

export async function extractTheme(
  targetDir: string,
  info: FrameworkInfo,
  opts: { force: boolean },
): Promise<ThemeSummary> {
  const vars: CssVarDecl[] = [];
  const errors: string[] = [];

  for (const cssFile of info.cssFiles) {
    const css = await fs.readFile(cssFile, "utf8");
    vars.push(...parseCssVars(css, path.relative(targetDir, cssFile)));
  }
  if (info.tailwindConfigPath) {
    const { vars: twVars, error } = await extractTailwindVars(info.tailwindConfigPath);
    vars.push(...twVars);
    if (error) errors.push(error);
  }

  const result = mapVarsToBrand(vars);
  let written = false;
  if (result.brand) {
    await writeGenerated(
      path.join(targetDir, ".flowlet/theme.json"),
      JSON.stringify(result.brand, null, 2) + "\n",
      opts,
    );
    written = true;
  } else {
    errors.push("could not assemble a valid BrandTokens object — write .flowlet/theme.json by hand");
  }
  const { brand: _brand, ...rest } = result;
  return { ...rest, written, errors, varCount: vars.length };
}
