import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  installLocalVendoPackages,
  type LocalPackRunner,
  type LocalVendoInstallSummary,
  type WorkspacePackage,
} from "./local-pack.js";
import { resolveAppRoot } from "./app-root.js";
import { normalizePostInjectionInstallCommand } from "./install-command.js";
import type { ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export type InjectRepo = Pick<ManifestEntry, "name" | "appDir"> & Partial<Pick<ManifestEntry, "bootstrap">>;
export type PackWorkspacePackage = LocalPackRunner;

export interface InjectCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface LocalVendoInjectResult extends LocalVendoInstallSummary {
  repoDir: string;
}

export interface LocalVendoInjector {
  inject(repo: InjectRepo): Promise<LocalVendoInjectResult>;
}

export interface CreateLocalVendoInjectorOptions {
  context?: CorpusRunContext;
  workspaceRoot?: string;
  runInstall?: boolean;
  buildWorkspace?: (workspaceRoot: string) => Promise<void>;
  pack?: PackWorkspacePackage;
  runInstallCommand?: (command: string, cwd: string) => Promise<void>;
  log?: (message: string) => void;
}

function runCommand(command: string, args: readonly string[], cwd: string): Promise<InjectCommandResult> {
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

function runShellCommand(command: string, cwd: string): Promise<InjectCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
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

async function checkedShellCommand(command: string, cwd: string): Promise<void> {
  const result = await runShellCommand(command, cwd);
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`${command} failed in ${cwd} with exit code ${result.code ?? "unknown"}:\n${output}`);
  }
}

async function defaultBuildWorkspace(workspaceRoot: string): Promise<void> {
  const result = await runCommand("pnpm", ["build"], workspaceRoot);
  if (result.code !== 0) {
    throw new Error(`pnpm build failed in ${workspaceRoot}:\n${result.stderr || result.stdout}`);
  }
}

async function defaultPackWorkspacePackage(
  pkg: WorkspacePackage,
  opts: { repoDir: string; vendorDir: string; fileName: string },
): Promise<void> {
  await mkdir(opts.vendorDir, { recursive: true });
  const result = await runCommand("pnpm", ["-C", pkg.dir, "pack", "--pack-destination", opts.vendorDir], opts.repoDir);
  if (result.code !== 0) {
    throw new Error(`pnpm pack failed for ${pkg.name}:\n${result.stderr || result.stdout}`);
  }
  await access(path.join(opts.vendorDir, opts.fileName)).catch(() => {
    throw new Error(`pnpm pack for ${pkg.name} did not create expected tarball ${opts.fileName}`);
  });
}

function assertPathHasNoSpaces(label: string, value: string): void {
  if (value.includes(" ")) {
    throw new Error(
      `local-pack known issue: paths containing spaces break local Vendo package injection; ${label} path contains a space: ${value}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function localFileSpec(value: string): boolean {
  return /^file:vendor\/.+\.tgz$/.test(value);
}

function packageTarballPrefix(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isVendoPackageName(name: string): boolean {
  return name === "vendoai" || name.startsWith("@vendoai/");
}

function lockfileMentionsVendoPackage(lockfile: string): boolean {
  return lockfile.includes("@vendoai/")
    || /(^|\n)\s*['"]?vendoai['"]?:/m.test(lockfile)
    || /\/vendoai\/[^/\s]+/i.test(lockfile);
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function findPnpmWorkspaceRoot(checkoutDir: string, targetDir: string): Promise<string | undefined> {
  const stop = path.resolve(checkoutDir);
  let current = path.resolve(targetDir);

  while (current === stop || current.startsWith(`${stop}${path.sep}`)) {
    if (await pathExists(path.join(current, "pnpm-workspace.yaml"))) return current;
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/** pnpm ≥10 errors on dangerouslyAllowAllBuilds when the workspace already
 * declares a curated build allowlist — detect that curation. */
async function pnpmDeclaresBuiltDependencies(installDir: string): Promise<boolean> {
  try {
    const source = await readFile(path.join(installDir, "pnpm-workspace.yaml"), "utf8");
    return /^\s*(onlyBuiltDependencies|neverBuiltDependencies)\s*:/m.test(source);
  } catch {
    return false;
  }
}

function localVendoTarballLockfileSpec(lockfile: string): boolean {
  return /file:[^\s"'#]*vendor\/vendoai(?:-[A-Za-z0-9._-]+)?-[^/\s"']+\.tgz/i.test(lockfile);
}

function lockfileHasRegistryVendoResolution(lockfile: string): boolean {
  return /registry\.npmjs\.org\/(?:@|%40)vendoai/i.test(lockfile)
    || /registry\.npmjs\.org\/vendoai(?:\/|-)/i.test(lockfile)
    || /registry\.yarnpkg\.com\/(?:@|%40)vendoai/i.test(lockfile)
    || /registry\.yarnpkg\.com\/vendoai(?:\/|-)/i.test(lockfile)
    || /(?:^|\n)\s*(?:resolution:\s*)?["']?(?:@vendoai\/[^@"'\s]+|vendoai)@npm:/m.test(lockfile);
}

function localPackageResolutionField(summary: LocalVendoInstallSummary): string {
  if (summary.packageManager === "pnpm") return "pnpm.overrides";
  if (summary.packageManager === "npm") return "overrides";
  return "resolutions";
}

function installCommandSource(repo: InjectRepo, summary: LocalVendoInstallSummary): string {
  const recipe = repo.bootstrap?.installCommand;
  if (recipe) {
    if (summary.packageManager === "pnpm" && /\bpnpm\s+install\b/.test(recipe)) return recipe;
    if (summary.packageManager === "npm" && /\bnpm\s+(?:ci|install)\b/.test(recipe)) return recipe;
    if ((summary.packageManager === "yarn-classic" || summary.packageManager === "yarn-berry") && /\byarn\s+install\b/.test(recipe)) return recipe;
  }
  return summary.installCommand;
}

async function tarballFileForPackage(vendorDir: string, name: string): Promise<string> {
  const entries = await readdir(vendorDir);
  const prefix = packageTarballPrefix(name);
  const tarballPattern = new RegExp(`^${escapeRegExp(prefix)}-\\d.*\\.tgz$`);
  const matches = entries.filter((entry) => tarballPattern.test(entry)).sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one local tarball for ${name} in ${vendorDir}, found ${matches.length}`);
  }
  return matches[0]!;
}

function tarballOverrideVersions(name: string, fileName: string): string[] {
  const prefix = packageTarballPrefix(name);
  const suffix = fileName.slice(prefix.length + 1, -".tgz".length);
  const version = suffix.match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0];
  if (!version) return [];

  const versions = new Set<string>([version]);
  const stableVersion = version.match(/^\d+\.\d+\.\d+/)?.[0];
  if (stableVersion) versions.add(stableVersion);
  return [...versions];
}

function fileSpecRelativeTo(baseDir: string, vendorDir: string, fileName: string): string {
  return `file:${path.relative(baseDir, path.join(vendorDir, fileName)).split(path.sep).join("/")}`;
}

function mergePnpmWorkspaceYamlOverrides(source: string, overrides: Record<string, string>): string {
  const additions = Object.entries(overrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`);
  const lines = source.trimEnd().split(/\r?\n/);
  const overridesIndex = lines.findIndex((line) => /^overrides:\s*(?:#.*)?$/.test(line));
  if (overridesIndex < 0) {
    return `${source.trimEnd()}\n\noverrides:\n${additions.join("\n")}\n`;
  }

  let insertIndex = overridesIndex + 1;
  while (
    insertIndex < lines.length
    && (lines[insertIndex]!.trim() === "" || lines[insertIndex]!.startsWith(" ") || lines[insertIndex]!.startsWith("#"))
  ) {
    insertIndex += 1;
  }

  return [
    ...lines.slice(0, insertIndex),
    ...additions,
    ...lines.slice(insertIndex),
  ].join("\n") + "\n";
}

async function localPnpmOverrideMap(summary: LocalVendoInstallSummary): Promise<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const name of summary.packages) {
    const fileName = await tarballFileForPackage(summary.vendorDir, name);
    const spec = fileSpecRelativeTo(summary.installDir ?? summary.vendorDir, summary.vendorDir, fileName);
    overrides[name] = spec;
    for (const version of tarballOverrideVersions(name, fileName)) {
      overrides[`${name}@${version}`] = spec;
    }
  }
  return overrides;
}

async function writeRootPackageJsonPnpmOverrides(
  installDir: string,
  overrides: Record<string, string>,
): Promise<void> {
  const packageJsonPath = path.join(installDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  const pnpm = isRecord(pkg["pnpm"]) ? { ...pkg["pnpm"] } : {};
  pnpm["overrides"] = {
    ...stringRecord(pnpm["overrides"]),
    ...overrides,
  };
  pkg["pnpm"] = pnpm;
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function writePnpmWorkspaceRootOverrides(
  repoDir: string,
  summary: LocalVendoInstallSummary,
): Promise<void> {
  if (summary.packageManager !== "pnpm" || !summary.installDir || path.resolve(summary.installDir) === path.resolve(repoDir)) {
    return;
  }
  const overrides = await localPnpmOverrideMap(summary);
  await writeRootPackageJsonPnpmOverrides(summary.installDir, overrides);

  const workspaceYaml = path.join(summary.installDir, "pnpm-workspace.yaml");
  const source = await readOptional(workspaceYaml);
  if (!source) return;
  await writeFile(workspaceYaml, mergePnpmWorkspaceYamlOverrides(source, overrides));
}

async function assertLocalVendoResolution(repoDir: string, summary: LocalVendoInstallSummary): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8")) as Record<string, unknown>;
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const section of dependencySections) {
    for (const [name, spec] of Object.entries(stringRecord(pkg[section]))) {
      if (isVendoPackageName(name) && !localFileSpec(spec)) {
        throw new Error(`${section}.${name} must resolve from a local file:vendor/*.tgz tarball, got ${spec}`);
      }
    }
  }

  const resolutionField = localPackageResolutionField(summary);
  const overridesContainer = summary.packageManager === "pnpm" && isRecord(pkg["pnpm"])
    ? pkg["pnpm"]["overrides"]
    : summary.packageManager === "npm"
      ? pkg["overrides"]
      : pkg["resolutions"];
  const overrides = stringRecord(overridesContainer);
  for (const name of summary.packages) {
    const spec = overrides[name];
    if (!spec || !localFileSpec(spec)) {
      throw new Error(`${resolutionField}.${name} must resolve from a local file:vendor/*.tgz tarball`);
    }
  }
  for (const [name, spec] of Object.entries(overrides)) {
    if (isVendoPackageName(name) && !localFileSpec(spec)) {
      throw new Error(`${resolutionField}.${name} must resolve from a local file:vendor/*.tgz tarball, got ${spec}`);
    }
  }

  const lockfileDirs = [...new Set([repoDir, summary.installDir ?? repoDir].map((dir) => path.resolve(dir)))];
  for (const lockfileDir of lockfileDirs) {
    for (const fileName of ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]) {
      const lockfile = await readOptional(path.join(lockfileDir, fileName));
      if (!lockfile) continue;
      const label = path.relative(repoDir, path.join(lockfileDir, fileName)) || fileName;
      if (lockfileHasRegistryVendoResolution(lockfile)) {
        throw new Error(`${label} still references registry.npmjs.org or registry.yarnpkg.com for Vendo packages`);
      }
      if (lockfileMentionsVendoPackage(lockfile) && !localVendoTarballLockfileSpec(lockfile)) {
        throw new Error(`${label} mentions Vendo packages without file:vendor/*.tgz resolution`);
      }
    }
  }
}

export function createLocalVendoInjector(options: CreateLocalVendoInjectorOptions = {}): LocalVendoInjector {
  const context = options.context ?? createRunContext();
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const cacheDir = path.join(context.reposDir, ".local-vendo-tarballs");
  const buildWorkspace = options.buildWorkspace ?? defaultBuildWorkspace;
  const sourcePack = options.pack ?? defaultPackWorkspacePackage;
  const runInstall = options.runInstall ?? true;
  const runInstallCommand = options.runInstallCommand ?? checkedShellCommand;
  const log = options.log ?? ((message: string) => { console.error(message); });
  let buildPromise: Promise<void> | null = null;
  const packed = new Map<string, Promise<void>>();

  const ensureBuilt = async (): Promise<void> => {
    buildPromise ??= buildWorkspace(workspaceRoot);
    await buildPromise;
  };

  const cachedPack: LocalPackRunner = async (pkg, opts) => {
    await ensureBuilt();
    const cacheFile = path.join(cacheDir, opts.fileName);
    let packPromise = packed.get(opts.fileName);
    if (!packPromise) {
      packPromise = sourcePack(pkg, { repoDir: workspaceRoot, vendorDir: cacheDir, fileName: opts.fileName });
      packed.set(opts.fileName, packPromise);
    }
    await packPromise;
    await mkdir(opts.vendorDir, { recursive: true });
    await copyFile(cacheFile, path.join(opts.vendorDir, opts.fileName));
  };

  return {
    async inject(repo: InjectRepo): Promise<LocalVendoInjectResult> {
      const checkoutDir = context.repoDir(repo.name);
      const repoDir = resolveAppRoot(repo, checkoutDir);
      assertPathHasNoSpaces("workspace", workspaceRoot);
      assertPathHasNoSpaces("corpus repo", repoDir);
      await mkdir(context.reposDir, { recursive: true });

      const summary = await installLocalVendoPackages(repoDir, workspaceRoot, { pack: cachedPack, packageManagerRoot: checkoutDir });
      const pnpmWorkspaceRoot = summary.packageManager === "pnpm"
        ? await findPnpmWorkspaceRoot(checkoutDir, repoDir)
        : undefined;
      const installDir = pnpmWorkspaceRoot ?? summary.installDir ?? repoDir;
      const installSummary = installDir === summary.installDir ? summary : { ...summary, installDir };
      await writePnpmWorkspaceRootOverrides(repoDir, installSummary);
      if (runInstall) {
        const sourceCommand = installCommandSource(repo, installSummary);
        // pnpm ≥10 rejects dangerouslyAllowAllBuilds when the repo curates its
        // own build allowlist (onlyBuiltDependencies/neverBuiltDependencies in
        // pnpm-workspace.yaml) — respect the repo's explicit config instead.
        const repoCuratesBuilds = installSummary.packageManager === "pnpm"
          && await pnpmDeclaresBuiltDependencies(installDir);
        const installCommand = normalizePostInjectionInstallCommand(sourceCommand, {
          dropIgnoreWorkspace: installSummary.packageManager === "pnpm" && installDir !== repoDir,
          disableYarnImmutableInstalls: installSummary.packageManager === "yarn-berry",
          pnpmConfig: installSummary.packageManager === "pnpm"
            ? [
                "--config.minimumReleaseAge=0",
                ...(repoCuratesBuilds ? [] : ["--config.dangerouslyAllowAllBuilds=true"]),
              ]
            : [],
        });
        if (installCommand.changed) {
          log(`Corpus harness normalized post-injection install command for ${repo.name} from "${sourceCommand}" to non-frozen "${installCommand.command}" so file:vendor lockfile updates are allowed.`);
        }
        if (installDir !== repoDir) {
          log(`Corpus harness running post-injection install for ${repo.name} from workspace root/package-manager root ${installDir} instead of appDir ${repoDir} so workspace:, catalog:, and root lockfile dependencies resolve.`);
        }
        await runInstallCommand(installCommand.command, installDir);
      }
      await assertLocalVendoResolution(repoDir, installSummary);

      return {
        ...installSummary,
        repoDir,
      };
    },
  };
}
