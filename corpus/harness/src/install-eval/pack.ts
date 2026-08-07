import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LOCAL_VENDO_PACKAGE_NAMES } from "../local-pack.js";

/**
 * Pack the whole publishable Vendo set (the same closure the corpus injector
 * ships as `vendor/*.tgz`) into a cache directory the local registry serves
 * from. Reuses the injector's doctrine — build once, pack per package, cache
 * by name-version file — without its package.json rewriting, because the
 * eval fixture's package.json must stay Vendo-free until the agent installs.
 */

function tarballFileName(name: string, version: string): string {
  const base = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${base}-${version}.tgz`;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type PackCommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<CommandResult>;

function defaultRunCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

export interface PackWorkspaceVendoTarballsOptions {
  workspaceRoot: string;
  cacheDir: string;
  runCommand?: PackCommandRunner;
  /** Skip `pnpm build` (tests, or a caller that already built). */
  skipBuild?: boolean;
  log?: (message: string) => void;
}

/** Build once, then pack every Vendo workspace package whose tarball is not
 * already cached. Returns the cache directory (the registry's tarballDir). */
export async function packWorkspaceVendoTarballs(options: PackWorkspaceVendoTarballsOptions): Promise<string> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const log = options.log ?? (() => {});
  const wanted = new Set<string>(LOCAL_VENDO_PACKAGE_NAMES);
  const packagesDir = path.join(options.workspaceRoot, "packages");
  await mkdir(options.cacheDir, { recursive: true });

  const toPack: { name: string; dir: string; fileName: string }[] = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    let manifest: { name?: string; version?: string };
    try {
      manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || !wanted.has(manifest.name)) continue;
    wanted.delete(manifest.name);
    const fileName = tarballFileName(manifest.name, manifest.version);
    if (!await pathExists(path.join(options.cacheDir, fileName))) {
      toPack.push({ name: manifest.name, dir, fileName });
    }
  }
  if (wanted.size > 0) {
    throw new Error(`install-eval pack: workspace packages missing under packages/: ${[...wanted].join(", ")}`);
  }

  if (toPack.length > 0 && options.skipBuild !== true) {
    log("install-eval: building the workspace before packing…");
    const build = await runCommand("pnpm", ["build"], options.workspaceRoot);
    if (build.code !== 0) throw new Error(`pnpm build failed:\n${build.stderr || build.stdout}`);
  }
  for (const pkg of toPack) {
    log(`install-eval: packing ${pkg.name} → ${pkg.fileName}`);
    const result = await runCommand("pnpm", ["-C", pkg.dir, "pack", "--pack-destination", options.cacheDir], options.workspaceRoot);
    if (result.code !== 0) throw new Error(`pnpm pack failed for ${pkg.name}:\n${result.stderr || result.stdout}`);
    if (!await pathExists(path.join(options.cacheDir, pkg.fileName))) {
      throw new Error(`pnpm pack for ${pkg.name} did not create ${pkg.fileName}`);
    }
  }
  return options.cacheDir;
}
