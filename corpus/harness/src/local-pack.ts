import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const LOCAL_DIRECT_DEPENDENCIES = ["@vendoai/vendo"] as const;

export const LOCAL_VENDO_PACKAGE_NAMES = [
  "@vendoai/core",
  "@vendoai/store",
  "@vendoai/agent",
  "@vendoai/actions",
  "@vendoai/guard",
  "@vendoai/apps",
  "@vendoai/automations",
  "@vendoai/ui",
  "@vendoai/telemetry",
  "@vendoai/mcp",
  "@vendoai/vendo",
  "vendoai",
] as const;

type PackageJson = Record<string, unknown>;
export type LocalPackageManager = "pnpm" | "npm" | "yarn-classic" | "yarn-berry";

export interface LocalTarball {
  name: string;
  fileName: string;
}

export interface LocalVendoInstallSummary {
  packageManager: LocalPackageManager;
  installCommand: string;
  installDir?: string;
  packages: string[];
  vendorDir: string;
}

export interface WorkspacePackage {
  name: string;
  version: string;
  dir: string;
}

export interface LocalPackRunner {
  (pkg: WorkspacePackage, opts: { repoDir: string; vendorDir: string; fileName: string }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return { ...value };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function npmPackFileName(name: string, version: string): string {
  const base = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${base}-${version}.tgz`;
}

function fileSpec(fileName: string): string {
  return `file:vendor/${fileName.split(path.sep).join("/")}`;
}

function fileSpecFromPackageDir(packageDir: string, vendorDir: string, fileName: string): string {
  return `file:${path.relative(packageDir, path.join(vendorDir, fileName)).split(path.sep).join("/")}`;
}

function isVendoPackageName(name: string): boolean {
  return name === "vendoai" || name.startsWith("@vendoai/");
}

function isVendoResolutionSelector(name: string): boolean {
  return name === "vendoai" || name.startsWith("vendoai@") || name.startsWith("@vendoai/");
}

function withoutVendoPackages(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => !isVendoPackageName(name)));
}

function withoutVendoResolutions(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => !isVendoResolutionSelector(name)));
}

async function readJsonFile(file: string): Promise<PackageJson> {
  return JSON.parse(await fs.readFile(file, "utf8")) as PackageJson;
}

async function discoverLocalPackages(repoDir: string): Promise<WorkspacePackage[]> {
  const wanted = new Set<string>(LOCAL_VENDO_PACKAGE_NAMES);
  const found = new Map<string, WorkspacePackage>();
  const entries = await fs.readdir(path.join(repoDir, "packages"), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(repoDir, "packages", entry.name);
    let pkg: PackageJson;
    try {
      pkg = await readJsonFile(path.join(dir, "package.json"));
    } catch {
      continue;
    }
    const name = pkg["name"];
    const version = pkg["version"];
    if (typeof name !== "string" || !wanted.has(name) || typeof version !== "string") continue;
    found.set(name, { name, version, dir });
  }

  const missing = LOCAL_VENDO_PACKAGE_NAMES.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`local Vendo monorepo is missing publishable workspace package${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  return LOCAL_VENDO_PACKAGE_NAMES.map((name) => found.get(name)!);
}

async function defaultPackRunner(
  pkg: WorkspacePackage,
  opts: { repoDir: string; vendorDir: string; fileName: string },
): Promise<void> {
  await fs.mkdir(opts.vendorDir, { recursive: true });
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("pnpm", ["-C", pkg.dir, "pack", "--pack-destination", opts.vendorDir], {
      cwd: opts.repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  if (output.code !== 0) {
    throw new Error(`pnpm pack failed for ${pkg.name}:\n${output.stderr || output.stdout}`);
  }
  await fs.access(path.join(opts.vendorDir, opts.fileName)).catch(() => {
    throw new Error(`pnpm pack for ${pkg.name} did not create expected tarball ${opts.fileName}`);
  });
}

function packageManagerFromField(value: unknown): LocalPackageManager | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("npm@")) return "npm";
  if (!value.startsWith("yarn@")) return null;
  const major = Number.parseInt(value.slice("yarn@".length).split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major < 2 ? "yarn-classic" : "yarn-berry";
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function readOptionalPackageJson(dir: string): Promise<PackageJson | null> {
  const source = await readOptional(path.join(dir, "package.json"));
  if (!source) return null;
  try {
    return JSON.parse(source) as PackageJson;
  } catch {
    return null;
  }
}

async function packageManagerSearchDirs(targetDir: string, packageManagerRoot?: string): Promise<string[]> {
  const target = path.resolve(targetDir);
  const explicitRoot = packageManagerRoot ? path.resolve(packageManagerRoot) : null;
  const dirs: string[] = [];
  let current = target;
  while (true) {
    dirs.push(current);
    if (explicitRoot && current === explicitRoot) break;
    if (!explicitRoot && await pathExists(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    if (explicitRoot && !current.startsWith(`${explicitRoot}${path.sep}`)) {
      dirs.push(explicitRoot);
      break;
    }
    current = parent;
  }
  return [...new Set(dirs)];
}

async function detectPackageManager(
  targetDir: string,
  targetPkg: PackageJson,
  packageManagerRoot?: string,
): Promise<{ packageManager: LocalPackageManager; installDir: string }> {
  const target = path.resolve(targetDir);
  const dirs = await packageManagerSearchDirs(target, packageManagerRoot);
  const targetField = packageManagerFromField(targetPkg["packageManager"]);
  if (targetField) return { packageManager: targetField, installDir: target };
  for (const dir of dirs) {
    if (dir === target) continue;
    const manager = packageManagerFromField((await readOptionalPackageJson(dir))?.["packageManager"]);
    if (manager) return { packageManager: manager, installDir: dir };
  }
  for (const dir of dirs) {
    const yarnLock = await readOptional(path.join(dir, "yarn.lock"));
    if (yarnLock) return { packageManager: yarnLock.includes("__metadata:") ? "yarn-berry" : "yarn-classic", installDir: dir };
  }
  for (const dir of dirs) {
    if (await pathExists(path.join(dir, "package-lock.json")) || await pathExists(path.join(dir, "npm-shrinkwrap.json"))) {
      return { packageManager: "npm", installDir: dir };
    }
  }
  for (const dir of dirs) {
    if (await pathExists(path.join(dir, "pnpm-lock.yaml"))) return { packageManager: "pnpm", installDir: dir };
  }
  return { packageManager: "pnpm", installDir: target };
}

// The umbrella's ai peer is >=6 <7 and init's starter provider is v6-era. A
// corpus target is a disposable fixture measuring OUR composition, so pin the
// whole tree to the v6 train — otherwise a target that already declares ai@5
// (top-level or transitively) collides with the umbrella peer and the harness
// measures a dependency conflict instead of the init it means to.
const AI_TRAIN_OVERRIDES: Record<string, string> = {
  ai: "6.0.28",
  "@ai-sdk/anthropic": "3.0.12",
};

function localOverrideMap(tarballs: readonly LocalTarball[]): Record<string, string> {
  return sortedRecord({
    ...Object.fromEntries(tarballs.map((tarball) => [tarball.name, fileSpec(tarball.fileName)])),
    ...AI_TRAIN_OVERRIDES,
  });
}

export function rewritePackageJsonForLocalVendo(
  source: string,
  tarballs: readonly LocalTarball[],
  packageManager: LocalPackageManager,
): string {
  const pkg = JSON.parse(source) as PackageJson;
  const byName = new Map(tarballs.map((tarball) => [tarball.name, tarball]));
  for (const name of LOCAL_VENDO_PACKAGE_NAMES) {
    if (!byName.has(name)) throw new Error(`local tarball map is missing ${name}`);
  }

  const originalDependencies = stringRecord(pkg["dependencies"]);
  const dependencies = withoutVendoPackages(originalDependencies);
  // Standalone local hosts may import publishable Vendo packages directly
  // (for example @vendoai/ui chrome). Keep those declared at the same direct
  // dependency level while replacing workspace:/registry specs with tarballs.
  for (const name of Object.keys(originalDependencies)) {
    if (name.startsWith("@vendoai/") && byName.has(name)) {
      dependencies[name] = fileSpec(byName.get(name)!.fileName);
    }
  }
  for (const name of LOCAL_DIRECT_DEPENDENCIES) dependencies[name] = fileSpec(byName.get(name)!.fileName);
  // Force the ai peer + init's starter provider onto the v6 train the umbrella
  // requires (a target's own ai major is irrelevant — we inject our umbrella).
  // Overwrite, don't ??=: a target pinning ai@5 would otherwise fight the peer.
  for (const [name, version] of Object.entries(AI_TRAIN_OVERRIDES)) dependencies[name] = version;
  pkg["dependencies"] = sortedRecord(dependencies);
  for (const field of ["devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    // Also strip a conflicting ai/@ai-sdk pin from the other sections so one
    // coherent v6 version wins the install.
    const original = stringRecord(pkg[field]);
    const values = withoutVendoPackages(original);
    if (field === "devDependencies") {
      for (const name of Object.keys(original)) {
        if (name.startsWith("@vendoai/") && byName.has(name)) {
          values[name] = fileSpec(byName.get(name)!.fileName);
        }
      }
    }
    for (const name of Object.keys(AI_TRAIN_OVERRIDES)) delete values[name];
    if (Object.keys(values).length > 0 || pkg[field] !== undefined) pkg[field] = sortedRecord(values);
  }

  const localOverrides = localOverrideMap(tarballs);
  if (packageManager === "pnpm") {
    const pnpm = objectRecord(pkg["pnpm"], "pnpm");
    const overrides = withoutVendoResolutions(objectRecord(pnpm["overrides"], "pnpm.overrides"));
    pnpm["overrides"] = sortedRecord({ ...overrides, ...localOverrides });
    pkg["pnpm"] = pnpm;
  } else if (packageManager === "npm") {
    const overrides = withoutVendoResolutions(objectRecord(pkg["overrides"], "overrides"));
    pkg["overrides"] = sortedRecord({ ...overrides, ...localOverrides });
  } else {
    const resolutions = withoutVendoResolutions(objectRecord(pkg["resolutions"], "resolutions"));
    pkg["resolutions"] = sortedRecord({ ...resolutions, ...localOverrides });
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function rewriteYarnRootResolutions(
  source: string,
  tarballs: readonly LocalTarball[],
  packageDir: string,
  vendorDir: string,
): string {
  const pkg = JSON.parse(source) as PackageJson;
  const resolutions = withoutVendoResolutions(objectRecord(pkg["resolutions"], "resolutions"));
  const localResolutions = Object.fromEntries(tarballs.map((tarball) => [
    tarball.name,
    fileSpecFromPackageDir(packageDir, vendorDir, tarball.fileName),
  ]));
  pkg["resolutions"] = sortedRecord({ ...resolutions, ...localResolutions });
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

async function replaceVendorDir(stagingDir: string, vendorDir: string): Promise<void> {
  if (!(await pathExists(vendorDir))) {
    await fs.rename(stagingDir, vendorDir);
    return;
  }
  const backupDir = await fs.mkdtemp(path.join(path.dirname(vendorDir), ".vendo-local-pack-backup-"));
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.rename(vendorDir, backupDir);
  try {
    await fs.rename(stagingDir, vendorDir);
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(vendorDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(backupDir, vendorDir).catch(() => {});
    throw error;
  }
}

export async function installLocalVendoPackages(
  targetDir: string,
  repoDir: string,
  opts: { pack?: LocalPackRunner; packageManagerRoot?: string } = {},
): Promise<LocalVendoInstallSummary> {
  const target = path.resolve(targetDir);
  const workspace = path.resolve(repoDir);
  const vendorDir = path.join(target, "vendor");
  const packages = await discoverLocalPackages(workspace);
  const tarballs = packages.map((pkg) => ({ name: pkg.name, fileName: npmPackFileName(pkg.name, pkg.version) }));
  const packageJsonPath = path.join(target, "package.json");
  const source = await fs.readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(source) as PackageJson;
  const detected = await detectPackageManager(target, pkg, opts.packageManagerRoot);
  const rewritten = rewritePackageJsonForLocalVendo(source, tarballs, detected.packageManager);
  const rootPackageJsonPath = path.join(detected.installDir, "package.json");
  const rootRewritten = (detected.packageManager === "yarn-classic" || detected.packageManager === "yarn-berry")
    && detected.installDir !== target
    ? rewriteYarnRootResolutions(await fs.readFile(rootPackageJsonPath, "utf8"), tarballs, detected.installDir, vendorDir)
    : null;

  const pack = opts.pack ?? defaultPackRunner;
  const stagingDir = await fs.mkdtemp(path.join(target, ".vendo-local-pack-"));
  try {
    if (await pathExists(vendorDir)) await fs.cp(vendorDir, stagingDir, { recursive: true });
    for (const entry of await fs.readdir(stagingDir)) {
      if (/^vendoai(?:-|$).+\.tgz$/.test(entry)) await fs.rm(path.join(stagingDir, entry), { force: true });
    }
    for (const pkgEntry of packages) {
      await pack(pkgEntry, {
        repoDir: workspace,
        vendorDir: stagingDir,
        fileName: npmPackFileName(pkgEntry.name, pkgEntry.version),
      });
    }
    await replaceVendorDir(stagingDir, vendorDir);
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  await fs.writeFile(packageJsonPath, rewritten);
  if (rootRewritten) await fs.writeFile(rootPackageJsonPath, rootRewritten);
  return {
    packageManager: detected.packageManager,
    installCommand: detected.packageManager === "pnpm"
      ? "pnpm install"
      : detected.packageManager === "npm"
        ? "npm install"
        : detected.packageManager === "yarn-berry"
          ? "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install"
          : "yarn install",
    installDir: detected.installDir,
    packages: packages.map((pkgEntry) => pkgEntry.name),
    vendorDir,
  };
}
