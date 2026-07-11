/**
 * Read-only inspection of a host app's `.vendo/` state and Vendo wiring.
 *
 * Pure fact-gathering — deterministic, no LLM, no writes. This module answers
 * "what already exists" (does theme.json exist, is tools.json the fallback
 * stub or real, which components have wrapper dirs, and whether the app is wired). It contains NO
 * decision logic about what to extract, propose, or fix — that's for the
 * callers (`init`, `refresh`, `doctor`, `sync`) to decide from these facts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { findAppDir, DEFAULT_THEME_STUB } from "./next-wiring.js";

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function readJson(p: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** Structural equality for plain JSON-shaped values — key order irrelevant. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  return aKeys.length === bKeys.length && aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

/** The fallback tools.json next-wiring's step 0 writes when none exists. */
const EMPTY_TOOLS_FALLBACK = { version: 1, tools: [], events: [] };

export type ToolsStatus = "missing" | "empty-fallback" | "real";

/** "default-stub" = still deep-equal to the wiring-written DEFAULT_THEME_STUB
 *  (no developer content); anything else that exists — including malformed
 *  JSON — is "real" and additive consumers keep it. */
export type ThemeStatus = "missing" | "default-stub" | "real";

export interface WiringState {
  /** "app" or "src/app" relative to targetDir, or null if no App Router root layout was found. */
  appDir: string | null;
  routeFile: boolean;
  rootFile: boolean;
  /** routeFile && rootFile */
  wired: boolean;
}

export interface VendoState {
  theme: { exists: boolean; status: ThemeStatus };
  tools: { exists: boolean; status: ToolsStatus };
  /** Component names with a wrapper dir under .vendo/components/ (descriptor.ts + impl.tsx present). */
  components: string[];
  wired: WiringState;
}

async function inspectComponents(targetDir: string): Promise<string[]> {
  const dir = path.join(targetDir, ".vendo/components");
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const base = path.join(dir, entry.name);
    const [hasDescriptor, hasImpl] = await Promise.all([
      exists(path.join(base, "descriptor.ts")),
      exists(path.join(base, "impl.tsx")),
    ]);
    if (hasDescriptor && hasImpl) names.push(entry.name);
  }
  return names.sort();
}

async function inspectWired(targetDir: string): Promise<WiringState> {
  const found = await findAppDir(targetDir);
  if (!found) return { appDir: null, routeFile: false, rootFile: false, wired: false };
  const { appDir } = found;
  const [routeTs, routeJs, rootTsx, rootJsx] = await Promise.all([
    exists(path.join(appDir, "api/vendo/[...path]/route.ts")),
    exists(path.join(appDir, "api/vendo/[...path]/route.js")),
    exists(path.join(appDir, "vendo-root.tsx")),
    exists(path.join(appDir, "vendo-root.jsx")),
  ]);
  const routeFile = routeTs || routeJs;
  const rootFile = rootTsx || rootJsx;
  return {
    appDir: path.relative(targetDir, appDir).split(path.sep).join("/"),
    routeFile,
    rootFile,
    wired: routeFile && rootFile,
  };
}

export async function inspectVendoState(targetDir: string): Promise<VendoState> {
  const themePath = path.join(targetDir, ".vendo/theme.json");
  const toolsPath = path.join(targetDir, ".vendo/tools.json");

  const [themeExists, toolsExists] = await Promise.all([exists(themePath), exists(toolsPath)]);
  let themeStatus: ThemeStatus = "missing";
  if (themeExists) {
    const parsed = await readJson(themePath);
    themeStatus = deepEqual(parsed, DEFAULT_THEME_STUB) ? "default-stub" : "real";
  }
  let toolsStatus: ToolsStatus = "missing";
  if (toolsExists) {
    const parsed = await readJson(toolsPath);
    toolsStatus = deepEqual(parsed, EMPTY_TOOLS_FALLBACK) ? "empty-fallback" : "real";
  }

  const [components, wired] = await Promise.all([
    inspectComponents(targetDir),
    inspectWired(targetDir),
  ]);

  return {
    theme: { exists: themeExists, status: themeStatus },
    tools: { exists: toolsExists, status: toolsStatus },
    components,
    wired,
  };
}
