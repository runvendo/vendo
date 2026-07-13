import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./theme/walk.js";

export type HostFramework = "next" | "express" | "unknown";

export interface VendoWiring {
  server: boolean;
  client: boolean;
}

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

/** Bounded source scan shared by init and doctor so their wiring verdicts agree. */
export async function detectVendoWiring(root: string): Promise<VendoWiring> {
  let server = false;
  let client = false;
  const files = await walk(root, (relativePath) => SOURCE_FILE.test(relativePath), SOURCE_SCAN_MAX_FILES);
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (code.includes("@vendoai/vendo/server") && /\bcreateVendo\s*\(/.test(code)) server = true;
    if (code.includes("<VendoRoot")) client = true;
    if (server && client) break;
  }
  return { server, client };
}
