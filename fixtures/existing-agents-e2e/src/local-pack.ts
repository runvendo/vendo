import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The journey installs this workspace's Vendo — with the unreleased BYO seam
 * — into a standalone temp scaffold, the corpus harness's local-pack pattern
 * (corpus/harness/src/local-pack.ts) in its lean npm-only form: pack the
 * publish set once, pin the whole closure to file:vendor/*.tgz via npm
 * overrides, add the two direct deps a BYO host declares. */
export const VENDO_PACKAGE_NAMES = [
  "@vendoai/core",
  "@vendoai/store",
  "@vendoai/agent",
  "@vendoai/actions",
  "@vendoai/guard",
  "@vendoai/mcp",
  "@vendoai/apps",
  "@vendoai/automations",
  "@vendoai/ui",
  "@vendoai/telemetry",
  "@vendoai/vendo",
  "vendoai",
] as const;

const DIRECT_DEPENDENCIES = ["@vendoai/vendo", "@vendoai/ui"] as const;

export interface LocalTarball {
  name: string;
  fileName: string;
}

export interface PackedVendo {
  vendorDir: string;
  tarballs: LocalTarball[];
}

function npmPackFileName(name: string, version: string): string {
  const base = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${base}-${version}.tgz`;
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}:\n${output}`));
    });
  });
}

/** Packs the publish set into destDir. Once per live run — journeys share it. */
export async function packLocalVendo(workspaceRoot: string, destDir: string): Promise<PackedVendo> {
  if (workspaceRoot.includes(" ") || destDir.includes(" ")) {
    throw new Error("local pack requires space-free paths (file: specs)");
  }
  await fs.mkdir(destDir, { recursive: true });
  // Discover by manifest name, not directory name (@vendoai/telemetry lives
  // in packages/vendo-telemetry) — the corpus harness's discovery rule.
  const byName = new Map<string, { dir: string; version: string }>();
  for (const entry of await fs.readdir(path.join(workspaceRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(workspaceRoot, "packages", entry.name);
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (typeof pkg.name === "string" && typeof pkg.version === "string") byName.set(pkg.name, { dir, version: pkg.version });
    } catch {
      continue;
    }
  }
  const tarballs: LocalTarball[] = [];
  for (const name of VENDO_PACKAGE_NAMES) {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`workspace is missing publishable package ${name}`);
    const fileName = npmPackFileName(name, found.version);
    await run("pnpm", ["-C", found.dir, "pack", "--pack-destination", destDir], workspaceRoot);
    await fs.access(path.join(destDir, fileName));
    tarballs.push({ name, fileName });
  }
  return { vendorDir: destDir, tarballs };
}

/** Copies the tarballs into `<target>/vendor` and rewrites the scaffold's
 * package.json: the two direct deps a BYO host installs, plus npm `overrides`
 * pinning every @vendoai package (the tarballs' own inter-deps resolve to
 * published versions otherwise). The scaffold keeps its own framework pins —
 * the examples already declare a coherent ai train. */
export async function injectLocalVendo(targetDir: string, packed: PackedVendo): Promise<void> {
  const vendorDir = path.join(targetDir, "vendor");
  await fs.mkdir(vendorDir, { recursive: true });
  for (const tarball of packed.tarballs) {
    await fs.copyFile(path.join(packed.vendorDir, tarball.fileName), path.join(vendorDir, tarball.fileName));
  }
  const fileSpec = (name: string): string =>
    `file:vendor/${packed.tarballs.find((tarball) => tarball.name === name)!.fileName}`;

  const packageJsonPath = path.join(targetDir, "package.json");
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  const dependencies = { ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}) };
  for (const name of Object.keys(dependencies)) {
    if (name === "vendoai" || name.startsWith("@vendoai/")) dependencies[name] = fileSpec(name);
  }
  for (const name of DIRECT_DEPENDENCIES) dependencies[name] = fileSpec(name);
  pkg["dependencies"] = dependencies;
  pkg["overrides"] = {
    ...(pkg["overrides"] as Record<string, string> | undefined ?? {}),
    ...Object.fromEntries(packed.tarballs.map((tarball) => [tarball.name, fileSpec(tarball.name)])),
  };
  await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
