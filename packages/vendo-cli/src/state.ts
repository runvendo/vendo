/**
 * Read-only inspection of a host app's `.vendo/` state and Vendo wiring.
 *
 * Pure fact-gathering — deterministic, no LLM, no writes. This module answers
 * "what already exists" (does theme.json exist, is tools.json the fallback
 * stub or real, which components have wrapper dirs, which source files
 * already contain VendoRemix anchors, is the app wired). It contains NO
 * decision logic about what to extract, propose, or fix — that's for the
 * callers (`init`, `refresh`, `doctor`, `sync`) to decide from these facts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "./fsx.js";
import { findAppDir } from "./next-wiring.js";

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

export interface RemixAnchorSite {
  /** Path relative to targetDir, forward-slash separated. */
  file: string;
  /** Literal anchor ids found in this file (dynamic `id={...}` anchors contribute no id here). */
  ids: string[];
}

export interface WiringState {
  /** "app" or "src/app" relative to targetDir, or null if no App Router root layout was found. */
  appDir: string | null;
  routeFile: boolean;
  rootFile: boolean;
  /** routeFile && rootFile */
  wired: boolean;
}

export interface VendoState {
  theme: { exists: boolean };
  tools: { exists: boolean; status: ToolsStatus };
  /** Component names with a wrapper dir under .vendo/components/ (descriptor.ts + impl.tsx present). */
  components: string[];
  /** App source files containing at least one <VendoRemix ...> anchor. */
  remixAnchors: RemixAnchorSite[];
  wired: WiringState;
}

// Literal-id capture inside a <VendoRemix ...> opening tag. A cheap regex for
// fact-gathering, not a parse: consumers key on file-level detection; the ids
// list is best-effort and may diverge from sync/capture.ts's AST walk on
// exotic attribute layouts. Dynamic ids (`id={...}`) simply yield no match.
const ANCHOR_ID_RE = /<VendoRemix\b[^>]*?\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

async function inspectRemixAnchors(targetDir: string): Promise<RemixAnchorSite[]> {
  const files = await walk(targetDir, (rel) => /\.(tsx|jsx)$/.test(rel));
  const sites: RemixAnchorSite[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("VendoRemix")) continue;
    const ids = [...text.matchAll(ANCHOR_ID_RE)].map((m) => (m[1] ?? m[2])!);
    sites.push({ file: path.relative(targetDir, file).split(path.sep).join("/"), ids });
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file));
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
  let toolsStatus: ToolsStatus = "missing";
  if (toolsExists) {
    const parsed = await readJson(toolsPath);
    toolsStatus = deepEqual(parsed, EMPTY_TOOLS_FALLBACK) ? "empty-fallback" : "real";
  }

  const [components, remixAnchors, wired] = await Promise.all([
    inspectComponents(targetDir),
    inspectRemixAnchors(targetDir),
    inspectWired(targetDir),
  ]);

  return {
    theme: { exists: themeExists },
    tools: { exists: toolsExists, status: toolsStatus },
    components,
    remixAnchors,
    wired,
  };
}
