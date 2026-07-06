import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const LOCAL_DIRECT_DEPENDENCIES = ["vendoai"] as const;

/** Installed as devDependencies: init wires `prebuild: "vendo sync"`, and
 *  pre-publish the `vendo` bin stub cannot npx @vendoai/cli from the registry —
 *  a locally-packed CLI is what makes `npm run build` work offline. All of the
 *  CLI's own @vendoai/* deps are devDependencies (vite-bundled into its dist),
 *  so packing it adds nothing else to the runtime closure. */
export const LOCAL_DEV_DEPENDENCIES = ["@vendoai/cli"] as const;

type PackageJson = Record<string, unknown>;
export type LocalPackageManager = "pnpm" | "npm" | "yarn-classic" | "yarn-berry";

export interface LocalTarball {
  name: string;
  fileName: string;
}

export type LocalPackageRewriteResult =
  | { kind: "updated"; source: string }
  | { kind: "skipped"; reason: string; manual: string };

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
  dependencies: Record<string, string>;
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

function objectRecord(value: unknown, label: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, reason: `${label} is not an object` };
  return { ok: true, value: { ...value } };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function fileSpec(fileName: string): string {
  return `file:vendor/${fileName.split(path.sep).join("/")}`;
}

function fileSpecFromPackageDir(packageDir: string, vendorDir: string, fileName: string): string {
  const tarballPath = path.join(vendorDir, fileName);
  return `file:${path.relative(packageDir, tarballPath).split(path.sep).join("/")}`;
}

function npmPackFileName(name: string, version: string): string {
  const base = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
  return `${base}-${version}.tgz`;
}

async function readJsonFile(file: string): Promise<PackageJson> {
  return JSON.parse(await fs.readFile(file, "utf8")) as PackageJson;
}

async function discoverWorkspacePackages(repoDir: string): Promise<Map<string, WorkspacePackage>> {
  const packagesDir = path.join(repoDir, "packages");
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkgPath = path.join(dir, "package.json");
    let pkg: PackageJson;
    try {
      pkg = await readJsonFile(pkgPath);
    } catch {
      continue;
    }
    if (typeof pkg["name"] !== "string") continue;
    const name = pkg["name"];
    // The umbrella `vendoai` package itself, plus every `@vendoai/*` internal —
    // the closure walk below starts from `vendoai` and `@vendoai/cli`.
    if (name !== "vendoai" && !name.startsWith("@vendoai/")) continue;
    if (typeof pkg["version"] !== "string") continue;
    packages.set(name, {
      name,
      version: pkg["version"],
      dir,
      dependencies: stringRecord(pkg["dependencies"]),
    });
  }
  return packages;
}

async function discoverLocalPackageClosure(repoDir: string): Promise<WorkspacePackage[]> {
  const packages = await discoverWorkspacePackages(repoDir);
  const seen = new Set<string>();
  const ordered: WorkspacePackage[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) return;
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`local Vendo monorepo is missing workspace package ${name}`);
    seen.add(name);
    ordered.push(pkg);
    for (const depName of Object.keys(pkg.dependencies).sort()) {
      if (depName.startsWith("@vendoai/")) visit(depName);
    }
  };
  for (const name of [...LOCAL_DIRECT_DEPENDENCIES, ...LOCAL_DEV_DEPENDENCIES]) visit(name);
  return ordered.sort((a, b) => a.name.localeCompare(b.name));
}

async function findFluidkitTarball(repoDir: string): Promise<string> {
  const vendorDir = path.join(repoDir, "vendor");
  let entries: string[];
  try {
    entries = await fs.readdir(vendorDir);
  } catch {
    throw new Error(`no fluidkit tarball found in ${path.relative(process.cwd(), vendorDir)}`);
  }
  const matches = entries
    .filter((name) => /^fluidkit-.+\.tgz$/.test(name))
    .sort();
  if (matches.length === 0) throw new Error(`no fluidkit tarball found in ${path.relative(process.cwd(), vendorDir)}`);
  if (matches.length > 1) {
    throw new Error(`multiple fluidkit tarballs found in ${path.relative(process.cwd(), vendorDir)}: ${matches.join(", ")}`);
  }
  return path.join(vendorDir, matches[0]!);
}

async function defaultPackRunner(
  pkg: WorkspacePackage,
  opts: { repoDir: string; vendorDir: string; fileName: string },
): Promise<void> {
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
  const packed = path.join(opts.vendorDir, opts.fileName);
  try {
    await fs.access(packed);
  } catch {
    throw new Error(`pnpm pack for ${pkg.name} did not create expected tarball ${opts.fileName}`);
  }
}

function packageManagerFromField(value: unknown): LocalPackageManager | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("npm@")) return "npm";
  if (!value.startsWith("yarn@")) return null;
  const version = value.slice("yarn@".length);
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) return "yarn-berry";
  return major >= 2 ? "yarn-berry" : "yarn-classic";
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
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

async function detectYarnLockfileKind(dir: string): Promise<LocalPackageManager | null> {
  const lockfile = await readOptional(path.join(dir, "yarn.lock"));
  if (!lockfile) return null;
  return lockfile.includes("__metadata:") ? "yarn-berry" : "yarn-classic";
}

async function packageManagerSearchDirs(targetDir: string, packageManagerRoot?: string): Promise<string[]> {
  const resolvedTarget = path.resolve(targetDir);
  const explicitRoot = packageManagerRoot ? path.resolve(packageManagerRoot) : null;
  const dirs: string[] = [];
  let current = resolvedTarget;
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
  const resolvedTarget = path.resolve(targetDir);
  const roots = await packageManagerSearchDirs(resolvedTarget, packageManagerRoot);
  const targetField = packageManagerFromField(targetPkg["packageManager"]);
  if (targetField) return { packageManager: targetField, installDir: resolvedTarget };
  for (const dir of roots) {
    if (dir === resolvedTarget) continue;
    const pkg = await readOptionalPackageJson(dir);
    const field = packageManagerFromField(pkg?.["packageManager"]);
    if (field) return { packageManager: field, installDir: dir };
  }
  for (const dir of roots) {
    const yarnKind = await detectYarnLockfileKind(dir);
    if (yarnKind) return { packageManager: yarnKind, installDir: dir };
  }
  for (const dir of roots) {
    if (await pathExists(path.join(dir, "package-lock.json")) || await pathExists(path.join(dir, "npm-shrinkwrap.json"))) {
      return { packageManager: "npm", installDir: dir };
    }
  }
  for (const dir of roots) {
    if (await pathExists(path.join(dir, "pnpm-lock.yaml"))) return { packageManager: "pnpm", installDir: dir };
  }
  return { packageManager: "pnpm", installDir: resolvedTarget };
}

export function rewritePackageJsonForLocalVendo(
  pkgJson: string,
  tarballs: readonly LocalTarball[],
  opts: { packageManager: LocalPackageManager },
): LocalPackageRewriteResult {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(pkgJson) as PackageJson;
  } catch {
    return {
      kind: "skipped",
      reason: "package.json is not valid JSON",
      manual: localPackageManualInstructions(tarballs, opts.packageManager),
    };
  }
  const byName = new Map(tarballs.map((tarball) => [tarball.name, tarball]));
  for (const name of [...LOCAL_DIRECT_DEPENDENCIES, ...LOCAL_DEV_DEPENDENCIES, "fluidkit"]) {
    if (!byName.has(name)) {
      return {
        kind: "skipped",
        reason: `local tarball map is missing ${name}`,
        manual: localPackageManualInstructions(tarballs, opts.packageManager),
      };
    }
  }

  const deps = stringRecord(pkg["dependencies"]);
  for (const name of LOCAL_DIRECT_DEPENDENCIES) {
    deps[name] = fileSpec(byName.get(name)!.fileName);
  }
  pkg["dependencies"] = sortedRecord(deps);

  const devDeps = stringRecord(pkg["devDependencies"]);
  for (const name of LOCAL_DEV_DEPENDENCIES) {
    devDeps[name] = fileSpec(byName.get(name)!.fileName);
  }
  pkg["devDependencies"] = sortedRecord(devDeps);

  const localOverrides = sortedRecord(
    Object.fromEntries(tarballs.map((tarball) => [tarball.name, fileSpec(tarball.fileName)])),
  );
  if (opts.packageManager === "pnpm") {
    const pnpmResult = objectRecord(pkg["pnpm"], "pnpm");
    if (!pnpmResult.ok) {
      return {
        kind: "skipped",
        reason: pnpmResult.reason,
        manual: localPackageManualInstructions(tarballs, opts.packageManager),
      };
    }
    const pnpm = pnpmResult.value;
    const overridesResult = objectRecord(pnpm["overrides"], "pnpm.overrides");
    if (!overridesResult.ok) {
      return {
        kind: "skipped",
        reason: overridesResult.reason,
        manual: localPackageManualInstructions(tarballs, opts.packageManager),
      };
    }
    pnpm["overrides"] = sortedRecord({ ...overridesResult.value, ...localOverrides });
    pkg["pnpm"] = pnpm;
  } else if (opts.packageManager === "npm") {
    const overridesResult = objectRecord(pkg["overrides"], "overrides");
    if (!overridesResult.ok) {
      return {
        kind: "skipped",
        reason: overridesResult.reason,
        manual: localPackageManualInstructions(tarballs, opts.packageManager),
      };
    }
    pkg["overrides"] = sortedRecord({ ...overridesResult.value, ...localOverrides });
  } else {
    const resolutionsResult = objectRecord(pkg["resolutions"], "resolutions");
    if (!resolutionsResult.ok) {
      return {
        kind: "skipped",
        reason: resolutionsResult.reason,
        manual: localPackageManualInstructions(tarballs, opts.packageManager),
      };
    }
    pkg["resolutions"] = sortedRecord({ ...resolutionsResult.value, ...localOverrides });
  }
  return { kind: "updated", source: JSON.stringify(pkg, null, 2) + "\n" };
}

function packageManagerResolutionField(packageManager: LocalPackageManager): string {
  if (packageManager === "pnpm") return "pnpm.overrides";
  if (packageManager === "npm") return "overrides";
  return "resolutions";
}

function isYarnPackageManager(packageManager: LocalPackageManager): boolean {
  return packageManager === "yarn-classic" || packageManager === "yarn-berry";
}

function localPackageManualInstructions(tarballs: readonly LocalTarball[], packageManager: LocalPackageManager): string {
  const byName = new Map(tarballs.map((tarball) => [tarball.name, tarball.fileName]));
  const spec = (name: string) =>
    `${JSON.stringify(name)}: ${JSON.stringify(byName.has(name) ? fileSpec(byName.get(name)!) : "file:vendor/<tarball>")}`;
  const direct = LOCAL_DIRECT_DEPENDENCIES.map(spec).join(", ");
  const dev = LOCAL_DEV_DEPENDENCIES.map(spec).join(", ");
  const overrides = tarballs
    .map((tarball) => `${JSON.stringify(tarball.name)}: ${JSON.stringify(fileSpec(tarball.fileName))}`)
    .join(", ");
  return `manually add package.json dependencies { ${direct} }, devDependencies { ${dev} }, and ${packageManagerResolutionField(packageManager)} { ${overrides} }`;
}

function rewriteYarnRootResolutionsForLocalVendo(
  pkgJson: string,
  tarballs: readonly LocalTarball[],
  opts: { packageDir: string; vendorDir: string },
): LocalPackageRewriteResult {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(pkgJson) as PackageJson;
  } catch {
    return {
      kind: "skipped",
      reason: "package.json is not valid JSON",
      manual: localPackageManualInstructions(tarballs, "yarn-berry"),
    };
  }
  const byName = new Map(tarballs.map((tarball) => [tarball.name, tarball]));
  for (const name of [...LOCAL_DIRECT_DEPENDENCIES, ...LOCAL_DEV_DEPENDENCIES, "fluidkit"]) {
    if (!byName.has(name)) {
      return {
        kind: "skipped",
        reason: `local tarball map is missing ${name}`,
        manual: localPackageManualInstructions(tarballs, "yarn-berry"),
      };
    }
  }
  const resolutionsResult = objectRecord(pkg["resolutions"], "resolutions");
  if (!resolutionsResult.ok) {
    return {
      kind: "skipped",
      reason: resolutionsResult.reason,
      manual: localPackageManualInstructions(tarballs, "yarn-berry"),
    };
  }
  const localResolutions = sortedRecord(
    Object.fromEntries(tarballs.map((tarball) => [
      tarball.name,
      fileSpecFromPackageDir(opts.packageDir, opts.vendorDir, tarball.fileName),
    ])),
  );
  pkg["resolutions"] = sortedRecord({ ...resolutionsResult.value, ...localResolutions });
  return { kind: "updated", source: JSON.stringify(pkg, null, 2) + "\n" };
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
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
  } catch (err) {
    await fs.rm(vendorDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(backupDir, vendorDir).catch(() => {});
    throw err;
  }
}

export async function installLocalVendoPackages(
  targetDir: string,
  repoDir: string,
  opts: { pack?: LocalPackRunner; packageManagerRoot?: string } = {},
): Promise<LocalVendoInstallSummary> {
  const resolvedTarget = path.resolve(targetDir);
  const resolvedRepo = path.resolve(repoDir);
  const vendorDir = path.join(resolvedTarget, "vendor");
  const packages = await discoverLocalPackageClosure(resolvedRepo);
  const fluidkit = await findFluidkitTarball(resolvedRepo);
  const fluidkitFileName = path.basename(fluidkit);
  const tarballs: LocalTarball[] = [
    ...packages.map((pkg) => ({ name: pkg.name, fileName: npmPackFileName(pkg.name, pkg.version) })),
    { name: "fluidkit", fileName: fluidkitFileName },
  ];

  const pkgPath = path.join(resolvedTarget, "package.json");
  const pkgJson = await fs.readFile(pkgPath, "utf8");
  let parsedPkg: PackageJson = {};
  try {
    parsedPkg = JSON.parse(pkgJson) as PackageJson;
  } catch {
    /* rewritePackageJsonForLocalVendo returns the actionable manual path */
  }
  const detectedPackageManager = await detectPackageManager(resolvedTarget, parsedPkg, opts.packageManagerRoot);
  const packageManager = detectedPackageManager.packageManager;
  const rewritten = rewritePackageJsonForLocalVendo(pkgJson, tarballs, { packageManager });
  if (rewritten.kind === "skipped") {
    throw new Error(`${rewritten.reason}; ${rewritten.manual}`);
  }
  const rootPkgPath = path.join(detectedPackageManager.installDir, "package.json");
  const rootRewritten = isYarnPackageManager(packageManager) && detectedPackageManager.installDir !== resolvedTarget
    ? rewriteYarnRootResolutionsForLocalVendo(await fs.readFile(rootPkgPath, "utf8"), tarballs, {
        packageDir: detectedPackageManager.installDir,
        vendorDir,
      })
    : null;
  if (rootRewritten?.kind === "skipped") {
    throw new Error(`${rootRewritten.reason}; ${rootRewritten.manual}`);
  }

  const pack = opts.pack ?? defaultPackRunner;
  const stagingDir = await fs.mkdtemp(path.join(resolvedTarget, ".vendo-local-pack-"));
  try {
    if (await pathExists(vendorDir)) {
      await fs.cp(vendorDir, stagingDir, { recursive: true });
    }
    for (const pkg of packages) {
      await pack(pkg, { repoDir: resolvedRepo, vendorDir: stagingDir, fileName: npmPackFileName(pkg.name, pkg.version) });
    }

    await fs.copyFile(fluidkit, path.join(stagingDir, fluidkitFileName));
    await replaceVendorDir(stagingDir, vendorDir);
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  await fs.writeFile(pkgPath, rewritten.source);
  if (rootRewritten?.kind === "updated") {
    await fs.writeFile(rootPkgPath, rootRewritten.source);
  }

  return {
    packageManager,
    installCommand: packageManager === "pnpm"
      ? "pnpm install"
      : packageManager === "npm"
        ? "npm install"
        : packageManager === "yarn-berry"
          ? "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install"
          : "yarn install",
    installDir: detectedPackageManager.installDir,
    packages: packages.map((pkg) => pkg.name),
    vendorDir,
  };
}
