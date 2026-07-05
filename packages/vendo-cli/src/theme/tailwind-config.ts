import { pathToFileURL } from "node:url";
import type { CssVarDecl } from "./css-vars.js";

/**
 * Extract theme tokens from a Tailwind v3 JS config by importing it (dev-time,
 * the developer's own code). Values are normalised into the same CssVarDecl
 * shape the CSS scanner produces so one mapping layer serves both.
 * TypeScript configs are NOT executed — reported for hand-editing instead.
 */
export async function extractTailwindVars(
  configPath: string,
): Promise<{ vars: CssVarDecl[]; error: string | null }> {
  if (configPath.endsWith(".ts")) {
    return { vars: [], error: "TypeScript Tailwind configs are not executed; fill theme.json by hand or convert to JS" };
  }
  let theme: Record<string, unknown>;
  try {
    const mod = await import(pathToFileURL(configPath).href);
    const cfg = (mod.default ?? mod) as { theme?: { extend?: Record<string, unknown> } & Record<string, unknown> };
    theme = { ...(cfg.theme ?? {}), ...((cfg.theme?.extend as Record<string, unknown>) ?? {}) };
  } catch (err) {
    return { vars: [], error: `could not load ${configPath}: ${err instanceof Error ? err.message : String(err)}` };
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
