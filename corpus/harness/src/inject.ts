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

function lockfileHasLocalVendoResolution(lockfile: string): boolean {
  return /file:(?:[^'"\s]+\/)?vendor\/vendoai-[^'"\s]+\.tgz/i.test(lockfile);
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

async function readPackageManager(dir: string): Promise<string | undefined> {
  const source = await readOptional(path.join(dir, "package.json"));
  if (!source) return undefined;
  try {
    const pkg = JSON.parse(source) as unknown;
    return isRecord(pkg) && typeof pkg["packageManager"] === "string" ? pkg["packageManager"] : undefined;
  } catch {
    return undefined;
  }
}

async function assertSupportedPackageManager(repo: InjectRepo, checkoutDir: string, targetDir: string): Promise<void> {
  const dirs = [...new Set([checkoutDir, targetDir])];
  for (const dir of dirs) {
    const packageManager = await readPackageManager(dir);
    if (packageManager?.startsWith("yarn@") || await pathExists(path.join(dir, "yarn.lock"))) {
      throw new Error(
        `Corpus repo ${repo.name} uses Yarn, but local Vendo package injection currently supports only pnpm and npm. This repo is blocked until Yarn injection support is implemented.`,
      );
    }
  }
}

function installCommandSource(repo: InjectRepo, summary: LocalVendoInstallSummary): string {
  const recipe = repo.bootstrap?.installCommand;
  if (recipe) {
    if (summary.packageManager === "pnpm" && /\bpnpm\s+install\b/.test(recipe)) return recipe;
    if (summary.packageManager === "npm" && /\bnpm\s+(?:ci|install)\b/.test(recipe)) return recipe;
  }
  return summary.installCommand;
}

async function assertLocalVendoResolution(
  repoDir: string,
  summary: LocalVendoInstallSummary,
  lockfileDir = repoDir,
): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8")) as Record<string, unknown>;
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const section of dependencySections) {
    for (const [name, spec] of Object.entries(stringRecord(pkg[section]))) {
      if (isVendoPackageName(name) && !localFileSpec(spec)) {
        throw new Error(`${section}.${name} must resolve from a local file:vendor/*.tgz tarball, got ${spec}`);
      }
    }
  }

  const overridesContainer = summary.packageManager === "pnpm" && isRecord(pkg["pnpm"])
    ? pkg["pnpm"]["overrides"]
    : pkg["overrides"];
  const overrides = stringRecord(overridesContainer);
  for (const name of summary.packages) {
    const spec = overrides[name];
    if (!spec || !localFileSpec(spec)) {
      throw new Error(`${summary.packageManager === "pnpm" ? "pnpm.overrides" : "overrides"}.${name} must resolve from a local file:vendor/*.tgz tarball`);
    }
  }
  for (const [name, spec] of Object.entries(overrides)) {
    if (isVendoPackageName(name) && !localFileSpec(spec)) {
      throw new Error(`${summary.packageManager === "pnpm" ? "pnpm.overrides" : "overrides"}.${name} must resolve from a local file:vendor/*.tgz tarball, got ${spec}`);
    }
  }

  const lockfileDirs = [...new Set([repoDir, lockfileDir].map((dir) => path.resolve(dir)))];
  for (const dir of lockfileDirs) {
    for (const fileName of ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json"]) {
      const lockfile = await readOptional(path.join(dir, fileName));
      if (!lockfile) continue;
      const label = path.relative(process.cwd(), path.join(dir, fileName)) || fileName;
      if (/registry\.npmjs\.org\/(?:@|%40)vendoai/i.test(lockfile) || /registry\.npmjs\.org\/vendoai(?:\/|-)/i.test(lockfile)) {
        throw new Error(`${label} still references registry.npmjs.org for Vendo packages`);
      }
      if (lockfileMentionsVendoPackage(lockfile) && !lockfileHasLocalVendoResolution(lockfile)) {
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
    initArgs(): string[] {
      return localVendoInitArgs(workspaceRoot);
    },
    async inject(repo: InjectRepo): Promise<LocalVendoInjectResult> {
      const checkoutDir = context.repoDir(repo.name);
      const repoDir = resolveAppRoot(repo, checkoutDir);
      assertPathHasNoSpaces("workspace", workspaceRoot);
      assertPathHasNoSpaces("corpus repo", repoDir);
      await mkdir(context.reposDir, { recursive: true });
      await assertSupportedPackageManager(repo, checkoutDir, repoDir);

      const summary = await installLocalVendoPackages(repoDir, workspaceRoot, { pack: cachedPack });
      const pnpmWorkspaceRoot = summary.packageManager === "pnpm"
        ? await findPnpmWorkspaceRoot(checkoutDir, repoDir)
        : undefined;
      const installDir = pnpmWorkspaceRoot ?? repoDir;
      if (runInstall) {
        const sourceCommand = installCommandSource(repo, summary);
        const installCommand = normalizePostInjectionInstallCommand(sourceCommand, {
          dropIgnoreWorkspace: Boolean(pnpmWorkspaceRoot && pnpmWorkspaceRoot !== repoDir),
          pnpmConfig: [
            "--config.minimumReleaseAge=0",
            "--config.dangerouslyAllowAllBuilds=true",
          ],
        });
        if (installCommand.changed) {
          log(`Corpus harness normalized post-injection install command for ${repo.name} from "${sourceCommand}" to non-frozen "${installCommand.command}" so file:vendor lockfile updates are allowed.`);
        }
        if (installDir !== repoDir) {
          log(`Corpus harness running post-injection install for ${repo.name} from pnpm workspace root ${installDir} instead of appDir ${repoDir} so workspace: and catalog: dependencies resolve.`);
        }
        await runInstallCommand(installCommand.command, installDir);
      }
      await assertLocalVendoResolution(repoDir, summary, installDir);

      return {
        ...summary,
        repoDir,
        initArgs: localVendoInitArgs(workspaceRoot),
      };
    },
  };
}
