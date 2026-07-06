import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { CssVarDecl } from "./css-vars.js";

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
  let theme: Record<string, unknown>;
  let tempDir: string | null = null;
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
    return { vars: [], error: `could not load ${configPath}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }

  const vars: CssVarDecl[] = [];
  const file = configPath;

  const colors = theme["colors"] as Record<string, unknown> | undefined;
  if (colors) {
    for (const [name, v] of Object.entries(colors)) {
      const value =
        typeof v === "string" ? v
        : v && typeof v === "object" ? ((v as Record<string, unknown>)["DEFAULT"] ?? (v as Record<string, unknown>)["500"]) : undefined;
      if (typeof value === "string") vars.push({ name: `--color-${name}`, value, file, darkScope: false });
    }
  }
  const radius = theme["borderRadius"] as Record<string, unknown> | undefined;
  if (radius) {
    for (const [name, v] of Object.entries(radius)) {
      if (typeof v === "string") vars.push({ name: name === "DEFAULT" ? "--radius" : `--radius-${name}`, value: v, file, darkScope: false });
    }
  }
  const fonts = theme["fontFamily"] as Record<string, unknown> | undefined;
  if (fonts) {
    for (const [name, v] of Object.entries(fonts)) {
      const value = Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : undefined;
      if (value) vars.push({ name: `--font-${name}`, value, file, darkScope: false });
    }
  }
  return { vars, error: null };
}
