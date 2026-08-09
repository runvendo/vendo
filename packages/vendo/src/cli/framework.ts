import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./theme/walk.js";

export type HostFramework = "next" | "express" | "unknown";

export interface VendoWiring {
  server: boolean;
  client: boolean;
  /** A VISIBLE agent surface is mounted — <VendoProvider> alone is a context
      provider that renders nothing (0.4.1 E2E cert B3: by-the-book installs
      ended doctor-green with nothing on screen). */
  surface: boolean;
  /** The host still uses the removed <VendoRoot> — doctor prints the swap. The
      NAME alone is not evidence: a host's own wrapper component may be called
      VendoRoot (Maple's is), so this is the import from @vendoai, or the tag
      with no <VendoProvider> anywhere in the source. */
  legacyRoot: boolean;
}

/** What counts as a visible surface: the shipped chrome (<VendoOverlay> and
    the pieces it is built from), the BYO embeds a host chat renders, and the
    hooks a host uses to drive a custom surface. Deliberately generous — this
    list gates a doctor FAILURE, so a host with any plausible surface of its
    own must pass. */
export const SURFACE_MARKERS: readonly string[] = [
  "<VendoOverlay",
  "<VendoThread",
  "<VendoTrigger",
  "<VendoPalette",
  "<VendoSlot",
  "<VendoAppEmbed",
  "<VendoApprovalEmbed",
  "<VendoToolResult",
  "useVendoOverlay(",
  "useVendoThread(",
  "useSlotApp(",
];

/** A `VendoRoot` named in an import from a Vendo package — the removed export
    taken from the package, the one spelling that can no longer resolve. (The
    specifier is not spelled out in prose here: the dependency guard reads a
    literal one as a real cross-package import.) */
const LEGACY_ROOT_IMPORT = /import\s*\{[^}]*\bVendoRoot\b[^}]*\}\s*from\s*["']@vendoai\//;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SOURCE_SCAN_MAX_FILES = 2_000;

export async function detectFramework(root: string): Promise<HostFramework> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const sections = [manifest.dependencies, manifest.devDependencies];
    if (sections.some((dependencies) => dependencies?.next !== undefined)) return "next";
    if (sections.some((dependencies) => dependencies?.express !== undefined)) return "express";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The workspace packages that look like the real host, for an init run one
    level too high: a monorepo root declares neither next nor express, so
    detection lands on the runtime-neutral custom scaffold and the dev never
    notices. Deliberately just the two conventional workspace dirs — a hint
    that names a candidate, not a workspace-glob resolver. Paths are relative
    and posix-style (they go straight into a `vendo init <dir>` suggestion). */
export async function workspaceHostCandidates(root: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const group of ["apps", "packages"]) {
    const entries = await readdir(join(root, group), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await detectFramework(join(root, group, entry.name)) !== "unknown") candidates.push(`${group}/${entry.name}`);
    }
  }
  return candidates;
}

/** Bounded source scan shared by init and doctor so their wiring verdicts
    agree. */
export async function detectVendoWiring(root: string): Promise<VendoWiring> {
  let server = false;
  let provider = false;
  let legacyTag = false;
  let legacyImport = false;
  let surface = false;
  const files = await walk(root, (relativePath) => SOURCE_FILE.test(relativePath), SOURCE_SCAN_MAX_FILES);
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (code.includes("@vendoai/vendo/server") && /\bcreateVendo\s*\(/.test(code)) server = true;
    if (code.includes("<VendoProvider")) provider = true;
    if (code.includes("<VendoRoot")) legacyTag = true;
    if (LEGACY_ROOT_IMPORT.test(code)) legacyImport = true;
    if (SURFACE_MARKERS.some((marker) => code.includes(marker))) surface = true;
    if (server && provider && surface) break;
  }
  return {
    server,
    client: provider || legacyTag,
    surface,
    legacyRoot: legacyImport || (legacyTag && !provider),
  };
}
