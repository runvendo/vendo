import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  installLocalVendoPackages,
  type LocalPackRunner,
  type LocalVendoInstallSummary,
  type WorkspacePackage,
} from "../../../packages/vendo-cli/src/local-pack.js";
import type { ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export type InjectRepo = Pick<ManifestEntry, "name">;
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

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function assertLocalVendoResolution(repoDir: string, summary: LocalVendoInstallSummary): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8")) as Record<string, unknown>;
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const section of dependencySections) {
    for (const [name, spec] of Object.entries(stringRecord(pkg[section]))) {
      if (name.startsWith("@vendoai/") && !localFileSpec(spec)) {
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
    if (name.startsWith("@vendoai/") && !localFileSpec(spec)) {
      throw new Error(`${summary.packageManager === "pnpm" ? "pnpm.overrides" : "overrides"}.${name} must resolve from a local file:vendor/*.tgz tarball, got ${spec}`);
    }
  }

  for (const fileName of ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json"]) {
    const lockfile = await readOptional(path.join(repoDir, fileName));
    if (!lockfile) continue;
    if (/registry\.npmjs\.org\/(?:@|%40)vendoai/i.test(lockfile)) {
      throw new Error(`${fileName} still references registry.npmjs.org for @vendoai packages`);
    }
    if (lockfile.includes("@vendoai/") && !lockfile.includes("file:vendor/vendoai-")) {
      throw new Error(`${fileName} mentions @vendoai packages without file:vendor/*.tgz resolution`);
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
      const repoDir = context.repoDir(repo.name);
      assertPathHasNoSpaces("workspace", workspaceRoot);
      assertPathHasNoSpaces("corpus repo", repoDir);
      await mkdir(context.reposDir, { recursive: true });

      const summary = await installLocalVendoPackages(repoDir, workspaceRoot, { pack: cachedPack });
      if (runInstall) {
        await runInstallCommand(summary.installCommand, repoDir);
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
