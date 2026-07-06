import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  installLocalVendoPackages,
  type LocalPackRunner,
  type LocalVendoInstallSummary,
  type WorkspacePackage,
} from "../../../packages/vendo-cli/src/local-pack.js";
import { resolveAppRoot } from "./app-root.js";
import type { ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export type InjectRepo = Pick<ManifestEntry, "name" | "appDir">;
export type PackWorkspacePackage = LocalPackRunner;

export interface InjectCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface LocalVendoInjectResult extends LocalVendoInstallSummary {
  repoDir: string;
  initArgs: string[];
}

export interface LocalVendoInjector {
  inject(repo: InjectRepo): Promise<LocalVendoInjectResult>;
  initArgs(): string[];
}

export interface CreateLocalVendoInjectorOptions {
  context?: CorpusRunContext;
  workspaceRoot?: string;
  runInstall?: boolean;
  buildWorkspace?: (workspaceRoot: string) => Promise<void>;
  pack?: PackWorkspacePackage;
  runInstallCommand?: (command: string, cwd: string) => Promise<void>;
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
    throw new Error(`${command} failed in ${cwd} with exit code ${result.code ?? "unknown"}:\n${result.stderr || result.stdout}`);
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

function isVendoPackageName(name: string): boolean {
  return name === "vendoai" || name.startsWith("@vendoai/");
}

function lockfileMentionsVendoPackage(lockfile: string): boolean {
  return lockfile.includes("@vendoai/")
    || /(^|\n)\s*['"]?vendoai['"]?:/m.test(lockfile)
    || /\/vendoai\/[^/\s]+/i.test(lockfile);
}

function scopedInstallCommand(command: string): string {
  return command === "pnpm install" ? "pnpm install --ignore-workspace" : command;
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

  const lockfileDirs = [...new Set([repoDir, summary.installDir ?? repoDir])];
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

export function localVendoInitArgs(workspaceRoot: string): string[] {
  return ["--local", path.resolve(workspaceRoot)];
}

export function createLocalVendoInjector(options: CreateLocalVendoInjectorOptions = {}): LocalVendoInjector {
  const context = options.context ?? createRunContext();
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const cacheDir = path.join(context.reposDir, ".local-vendo-tarballs");
  const buildWorkspace = options.buildWorkspace ?? defaultBuildWorkspace;
  const sourcePack = options.pack ?? defaultPackWorkspacePackage;
  const runInstall = options.runInstall ?? true;
  const runInstallCommand = options.runInstallCommand ?? checkedShellCommand;
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
    initArgs(): string[] {
      return localVendoInitArgs(workspaceRoot);
    },
    async inject(repo: InjectRepo): Promise<LocalVendoInjectResult> {
      const checkoutDir = context.repoDir(repo.name);
      const repoDir = resolveAppRoot(repo, checkoutDir);
      assertPathHasNoSpaces("workspace", workspaceRoot);
      assertPathHasNoSpaces("corpus repo", repoDir);
      await mkdir(context.reposDir, { recursive: true });

      const summary = await installLocalVendoPackages(repoDir, workspaceRoot, { pack: cachedPack, packageManagerRoot: checkoutDir });
      if (runInstall) {
        await runInstallCommand(scopedInstallCommand(summary.installCommand), summary.installDir ?? repoDir);
      }
      await assertLocalVendoResolution(repoDir, summary);

      return {
        ...summary,
        repoDir,
        initArgs: localVendoInitArgs(workspaceRoot),
      };
    },
  };
}
