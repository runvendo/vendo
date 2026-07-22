import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./theme/walk.js";

export type HostFramework = "next" | "express" | "unknown";

export interface VendoWiring {
  server: boolean;
  client: boolean;
  /** A VISIBLE agent surface is mounted — <VendoRoot> alone is a context
      provider that renders nothing (0.4.1 E2E cert B3: by-the-book installs
      ended doctor-green with nothing on screen). */
  surface: boolean;
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

/** Bounded source scan shared by init and doctor so their wiring verdicts
    agree. `exclude` skips generated files whose own markers would count as
    host wiring (init's layout decision excludes the vendo-root wrapper: its
    <VendoOverlay /> is only real once a layout mounts the wrapper itself). */
export async function detectVendoWiring(root: string, options: { exclude?: string[] } = {}): Promise<VendoWiring> {
  let server = false;
  let client = false;
  let surface = false;
  const excluded = new Set(options.exclude ?? []);
  const files = await walk(root, (relativePath) => SOURCE_FILE.test(relativePath), SOURCE_SCAN_MAX_FILES);
  for (const file of files) {
    if (excluded.has(file)) continue;
    const source = await readFile(file, "utf8").catch(() => "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (code.includes("@vendoai/vendo/server") && /\bcreateVendo\s*\(/.test(code)) server = true;
    if (code.includes("<VendoRoot") || code.includes("<VendoProvider")) client = true;
    if (SURFACE_MARKERS.some((marker) => code.includes(marker))) surface = true;
    if (server && client && surface) break;
  }
  return { server, client, surface };
}
