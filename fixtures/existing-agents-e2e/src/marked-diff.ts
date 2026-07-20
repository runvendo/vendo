import { promises as fs } from "node:fs";
import path from "node:path";

/** The examples fence every added line with `--- vendo` / `--- /vendo`
 * markers (see examples/&#42;/README.md). This module is the programmatic form
 * of that contract: derive the unmodified framework starter by stripping the
 * fenced blocks, and apply the marked BYO diff by copying the fenced files
 * back. `apply(strip(example)) == example` by construction, which is exactly
 * what makes the journey honest — the markers alone carry the integration. */

const OPEN_MARKER = /---\s+vendo\b/;
const CLOSE_MARKER = /---\s+\/vendo\b/;

/** Removes every line from a `--- vendo` line through the next `--- /vendo`
 * line, inclusive. Throws on unbalanced fences so a mis-marked example fails
 * loudly instead of producing a half-starter. */
export function stripVendoBlocks(source: string, label = "source"): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const closes = CLOSE_MARKER.test(line);
    const opens = !closes && OPEN_MARKER.test(line);
    if (opens) {
      depth += 1;
      continue;
    }
    if (closes) {
      if (depth === 0) throw new Error(`${label}: '--- /vendo' without an opening marker`);
      depth -= 1;
      continue;
    }
    if (depth === 0) kept.push(line);
  }
  if (depth !== 0) throw new Error(`${label}: unclosed '--- vendo' block`);
  return kept.join("\n");
}

export function hasVendoMarkers(source: string): boolean {
  return OPEN_MARKER.test(source);
}

/** A file whose content is nothing but fenced blocks is vendo-owned outright
 * (lib/vendo.ts, the wire route): the starter simply does not have it. */
export function isWhollyVendoOwned(source: string): boolean {
  return hasVendoMarkers(source) && stripVendoBlocks(source).trim() === "";
}

/** Never part of the framework starter, never part of the runtime diff. */
const WALK_EXCLUDES = new Set([
  "node_modules",
  ".next",
  ".git",
  "vendor",
  ".turbo",
  ".mastra",
]);

/** Example files that exist for the workspace (tests, docs, lockstate), not
 * for either the starter or the BYO diff. */
const EXAMPLE_ONLY = new Set(["e2e", "README.md", "vitest.config.ts", ".env.local", ".env"]);

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (WALK_EXCLUDES.has(entry.name)) continue;
      if (rel === "" && EXAMPLE_ONLY.has(entry.name)) continue;
      // The example's runtime state, never part of the starter or the diff.
      // Copying .vendo/data would transplant a LIVE PGlite cluster file-by-file
      // (dropping its empty dirs) — postgres then refuses to start on it.
      if (relPath === ".vendo/data" || relPath.endsWith(".db") || /\.duckdb/.test(entry.name)) continue;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), relPath);
      else out.push(relPath);
    }
  }
  await visit(root, "");
  return out.sort();
}

function looksBinary(relPath: string): boolean {
  return /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|svg|db|duckdb)$/i.test(relPath);
}

/** The starter's package.json is the example's minus everything Vendo (and
 * minus the example's own test rig): the `vendo init` journey re-adds Vendo
 * the way a real host would — via dependency injection + install. */
export function starterPackageJson(source: string): string {
  const pkg = JSON.parse(source) as Record<string, unknown>;
  pkg["name"] = String(pkg["name"] ?? "starter").replace("@vendoai-examples/", "journey-starter-");
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const section = pkg[field];
    if (typeof section !== "object" || section === null) continue;
    for (const name of Object.keys(section)) {
      if (name === "vendoai" || name.startsWith("@vendoai/") || name === "vitest") {
        delete (section as Record<string, unknown>)[name];
      }
    }
  }
  const scripts = pkg["scripts"];
  if (typeof scripts === "object" && scripts !== null) delete (scripts as Record<string, unknown>)["test"];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export interface StarterDerivation {
  /** Files written to the starter (relative paths). */
  written: string[];
  /** Vendo-owned files skipped entirely (the marked diff adds them back). */
  vendoOwned: string[];
}

/** Derives the unmodified framework starter from an example: strips fenced
 * blocks from shared files, drops vendo-owned files (whole-file fences and
 * the `.vendo/` manifest dir), and de-Vendos package.json. */
export async function deriveStarter(exampleDir: string, targetDir: string): Promise<StarterDerivation> {
  const written: string[] = [];
  const vendoOwned: string[] = [];
  for (const rel of await walkFiles(exampleDir)) {
    const absolute = path.join(exampleDir, rel);
    if (rel === ".vendo/tools.json" || rel.startsWith(".vendo/")) {
      vendoOwned.push(rel);
      continue;
    }
    const target = path.join(targetDir, rel);
    if (looksBinary(rel)) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(absolute, target);
      written.push(rel);
      continue;
    }
    const source = await fs.readFile(absolute, "utf8");
    if (rel === "package.json") {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, starterPackageJson(source));
      written.push(rel);
      continue;
    }
    if (isWhollyVendoOwned(source)) {
      vendoOwned.push(rel);
      continue;
    }
    const content = hasVendoMarkers(source) ? stripVendoBlocks(source, rel) : source;
    if (content.includes("@vendoai/")) {
      throw new Error(`${rel}: starter derivation left an unfenced @vendoai import — the example's markers are incomplete`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    written.push(rel);
  }
  return { written: written.sort(), vendoOwned: vendoOwned.sort() };
}

/** Applies the example's marked BYO diff to a starter tree: every fenced file
 * is copied whole (shared files gain exactly their fenced lines back), every
 * vendo-owned file (whole-file fences plus `.vendo/`, notably tools.json) is
 * added. package.json is deliberately untouched — dependencies are the
 * injection/install step's job, exactly as in a real integration. */
export async function applyMarkedDiff(exampleDir: string, targetDir: string): Promise<string[]> {
  const applied: string[] = [];
  for (const rel of await walkFiles(exampleDir)) {
    if (rel === "package.json" || looksBinary(rel)) continue;
    const absolute = path.join(exampleDir, rel);
    const vendoManifest = rel.startsWith(".vendo/");
    if (!vendoManifest && !hasVendoMarkers(await fs.readFile(absolute, "utf8"))) continue;
    const target = path.join(targetDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(absolute, target);
    applied.push(rel);
  }
  return applied.sort();
}
