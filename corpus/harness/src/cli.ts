import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapRepo as defaultBootstrapRepo,
  type BootstrapOptions,
  type BootstrapResult,
} from "./bootstrap.js";
import { resolveAppRoot } from "./app-root.js";
import {
  bootRepo as defaultBootRepo,
  type BootHandle,
  type BootRepoOptions,
} from "./boot.js";
import {
  ensureRepoCheckout as defaultEnsureRepoCheckout,
  type CloneRepo,
  type EnsureRepoCheckoutOptions,
} from "./clone.js";
import {
  createLocalVendoInjector,
  type CreateLocalVendoInjectorOptions,
  type LocalVendoInjector,
} from "./inject.js";
import {
  runVendoInitStep,
  type InitStepArtifacts,
  type InitStepRepo,
  type InitStepResult,
  type RunVendoInitStepOptions,
} from "./init-step.js";
import { prepareE2eRepo as defaultPrepareE2eRepo } from "./e2e-prep.js";
import {
  runLiveDoctor as defaultRunLiveDoctor,
  type LiveDoctorResult,
  type RunLiveDoctorOptions,
} from "./doctor-live.js";
import {
  runE2eLayer as defaultRunE2eLayer,
  type E2eLayerContext,
  type E2eLayerRunResult,
} from "./layers/e2e.js";
import {
  runScoredLayer as defaultRunScoredLayer,
  type ScoredLayerContext,
  type ScoredLayerRunResult,
} from "./layers/scored.js";
import {
  corpusHostCommandEnv,
  runStructuralLayer as defaultRunStructuralLayer,
  type StructuralCheckResult,
  type StructuralCommandResult,
  type StructuralCommandRunner,
  type StructuralCommandSnapshot,
  type StructuralHostBaseline,
  type StructuralLayerContext,
} from "./layers/structural.js";
import { loadManifest as defaultLoadManifest, type CorpusManifest, type ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";
import {
  captureGalleryRepo as defaultCaptureGalleryRepo,
  discoverConfiguredGalleryRepoNames as defaultDiscoverConfiguredGalleryRepoNames,
  writeGalleryHtml as defaultWriteGalleryHtml,
  type CaptureGalleryRepoOptions,
  type GalleryRepoResult,
  type WriteGalleryHtmlOptions,
} from "./gallery.js";
import {
  buildScorecard,
  renderScorecardMarkdown,
  scorecardExitCode,
  writeScorecardArtifacts,
  type ScorecardLayerInput,
  type ScorecardRepoInput,
} from "./scorecard.js";
import { discoverAiConfiguredRepoNames as defaultDiscoverAiConfiguredRepoNames } from "./ai/expectations.js";
import {
  DEFAULT_MODEL_LABEL,
  agentSdkDir,
  buildAiScoreboard,
  corpusExtractionHarness,
  ensureAgentSdk as defaultEnsureAgentSdk,
  renderAiScoreboardMarkdown,
  runAiRepoMatrix as defaultRunAiRepoMatrix,
  writeAiScoreboardArtifacts,
  type AiRepoResult,
  type RunAiRepoMatrixOptions,
} from "./ai/matrix.js";
import type { ExtractionHarness } from "@vendoai/vendo/extract";
import {
  INSTALL_EVAL_DEFAULTS,
  runInstallEvalCommand as defaultRunInstallEvalCommand,
  type InstallEvalCommandOptions,
  type InstallEvalDeps,
} from "./install-eval/run.js";
import { INSTALL_EVAL_FIXTURES } from "./install-eval/fixtures.js";

const usage = `Usage:
  pnpm corpus --help
  pnpm corpus validate
  pnpm corpus list
  pnpm corpus run [repo...] --layer <1|2|3> [--json] [--strict]
  pnpm corpus boot <repo> [--timeout-ms <ms>]
  pnpm corpus gallery [repo...]
  pnpm corpus ai [repo...] [--model <id>]... [--json] [--strict]
  pnpm corpus install-eval [fixture...] [--model <id>] [--dry-run] [--json] [--strict]
                           [--turn-budget <n>] [--time-budget-ms <ms>] [--max-budget-usd <usd>]

Commands:
  validate  Load and validate corpus/manifest.json.
  list      Print manifest repo names with tier and source revision/path.
  run       Clone, bootstrap, inject local Vendo, run init, and execute selected layers.
  boot      Clone, bootstrap, inject local Vendo, run init, boot one deep-tier app, and wait for Ctrl-C.
  gallery   Boot configured deep-tier repos and capture native/generated screenshots, GIFs, and timings.
  ai        Run the AI extraction matrix (repo × model) and score against ai-expected.json labels.
            Needs a real model credential (ANTHROPIC_API_KEY or a Claude Code login); never part of pnpm test.
  install-eval  Prove a real coding agent installs Vendo from the docs' copy-paste prompt alone:
            clean fixture copies (${INSTALL_EVAL_FIXTURES.map((fixture) => fixture.name).join(", ")}),
            headless Claude Code, machine scoring, report under corpus/reports/.
            Spends real model money per live run; never part of pnpm test or CI. --dry-run scores a
            canned transcript without invoking the agent.
`;

const defaultWorkspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

type Stdout = (line: string) => void;
type Stderr = (line: string) => void;

export interface CorpusCliDependencies {
  stdout?: Stdout;
  stderr?: Stderr;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  loadManifest?: () => Promise<CorpusManifest>;
  createContext?: () => CorpusRunContext;
  ensureRepoCheckout?: (repo: CloneRepo, options?: EnsureRepoCheckoutOptions) => Promise<string>;
  bootstrapRepo?: (repo: ManifestEntry, options?: BootstrapOptions) => Promise<BootstrapResult>;
  createInjector?: (options?: CreateLocalVendoInjectorOptions) => LocalVendoInjector;
  runInit?: (repo: InitStepRepo, options?: RunVendoInitStepOptions) => Promise<InitStepResult>;
  bootRepo?: (repo: ManifestEntry, options?: BootRepoOptions) => Promise<BootHandle>;
  waitForBootShutdown?: (handle: BootHandle, repo: ManifestEntry) => Promise<void>;
  runStructuralLayer?: (ctx: StructuralLayerContext) => Promise<StructuralCheckResult[]>;
  runScoredLayer?: (ctx: ScoredLayerContext) => Promise<ScoredLayerRunResult>;
  prepareE2eRepo?: (repo: ManifestEntry, appRoot: string, logsDir: string) => Promise<string[]>;
  runE2eLayer?: (ctx: E2eLayerContext) => Promise<E2eLayerRunResult>;
  runLiveDoctor?: (options: RunLiveDoctorOptions) => Promise<LiveDoctorResult>;
  discoverConfiguredGalleryRepoNames?: (expectationsRoot: string) => Promise<string[]>;
  captureGalleryRepo?: (options: CaptureGalleryRepoOptions) => Promise<GalleryRepoResult>;
  writeGalleryHtml?: (options: WriteGalleryHtmlOptions) => Promise<string>;
  commandRunner?: StructuralCommandRunner;
  discoverAiConfiguredRepoNames?: (expectationsRoot: string) => Promise<string[]>;
  ensureAgentSdk?: (sdkDir: string) => Promise<void>;
  createExtractionHarness?: (sdkDir: string) => ExtractionHarness;
  runAiRepoMatrix?: (options: RunAiRepoMatrixOptions) => Promise<AiRepoResult>;
  runInstallEval?: (options: InstallEvalCommandOptions, deps: InstallEvalDeps) => Promise<number>;
}

interface ResolvedDeps {
  stdout: Stdout;
  stderr: Stderr;
  now: () => Date;
  env: NodeJS.ProcessEnv | undefined;
  workspaceRoot: string | undefined;
  loadManifest: () => Promise<CorpusManifest>;
  createContext: () => CorpusRunContext;
  ensureRepoCheckout: (repo: CloneRepo, options?: EnsureRepoCheckoutOptions) => Promise<string>;
  bootstrapRepo: (repo: ManifestEntry, options?: BootstrapOptions) => Promise<BootstrapResult>;
  createInjector: (options?: CreateLocalVendoInjectorOptions) => LocalVendoInjector;
  runInit: (repo: InitStepRepo, options?: RunVendoInitStepOptions) => Promise<InitStepResult>;
  bootRepo: (repo: ManifestEntry, options?: BootRepoOptions) => Promise<BootHandle>;
  waitForBootShutdown: (handle: BootHandle, repo: ManifestEntry) => Promise<void>;
  runStructuralLayer: (ctx: StructuralLayerContext) => Promise<StructuralCheckResult[]>;
  runScoredLayer: (ctx: ScoredLayerContext) => Promise<ScoredLayerRunResult>;
  prepareE2eRepo: (repo: ManifestEntry, appRoot: string, logsDir: string) => Promise<string[]>;
  runE2eLayer: (ctx: E2eLayerContext) => Promise<E2eLayerRunResult>;
  runLiveDoctor: (options: RunLiveDoctorOptions) => Promise<LiveDoctorResult>;
  discoverConfiguredGalleryRepoNames: (expectationsRoot: string) => Promise<string[]>;
  captureGalleryRepo: (options: CaptureGalleryRepoOptions) => Promise<GalleryRepoResult>;
  writeGalleryHtml: (options: WriteGalleryHtmlOptions) => Promise<string>;
  commandRunner: StructuralCommandRunner;
  discoverAiConfiguredRepoNames: (expectationsRoot: string) => Promise<string[]>;
  ensureAgentSdk: (sdkDir: string) => Promise<void>;
  createExtractionHarness: (sdkDir: string) => ExtractionHarness;
  runAiRepoMatrix: (options: RunAiRepoMatrixOptions) => Promise<AiRepoResult>;
  runInstallEval: (options: InstallEvalCommandOptions, deps: InstallEvalDeps) => Promise<number>;
}

interface RunCommandOptions {
  repoNames: string[];
  layer: 1 | 2 | 3;
  json: boolean;
  strict: boolean;
}

interface BootCommandOptions {
  repoName: string;
  timeoutMs?: number;
}

interface GalleryCommandOptions {
  repoNames: string[];
}

interface LoggedCommandRunner {
  runner: StructuralCommandRunner;
  logPaths: string[];
}

function resolveDeps(deps: CorpusCliDependencies = {}): ResolvedDeps {
  return {
    stdout: deps.stdout ?? ((line) => { console.log(line); }),
    stderr: deps.stderr ?? ((line) => { console.error(line); }),
    now: deps.now ?? (() => new Date()),
    env: deps.env,
    workspaceRoot: deps.workspaceRoot ?? defaultWorkspaceRoot,
    loadManifest: deps.loadManifest ?? defaultLoadManifest,
    createContext: deps.createContext ?? createRunContext,
    ensureRepoCheckout: deps.ensureRepoCheckout ?? defaultEnsureRepoCheckout,
    bootstrapRepo: deps.bootstrapRepo ?? defaultBootstrapRepo,
    createInjector: deps.createInjector ?? createLocalVendoInjector,
    runInit: deps.runInit ?? runVendoInitStep,
    bootRepo: deps.bootRepo ?? defaultBootRepo,
    waitForBootShutdown: deps.waitForBootShutdown ?? waitForBootShutdownSignal,
    runStructuralLayer: deps.runStructuralLayer ?? defaultRunStructuralLayer,
    runScoredLayer: deps.runScoredLayer ?? defaultRunScoredLayer,
    prepareE2eRepo: deps.prepareE2eRepo ?? defaultPrepareE2eRepo,
    runE2eLayer: deps.runE2eLayer ?? defaultRunE2eLayer,
    runLiveDoctor: deps.runLiveDoctor ?? defaultRunLiveDoctor,
    discoverConfiguredGalleryRepoNames: deps.discoverConfiguredGalleryRepoNames ?? defaultDiscoverConfiguredGalleryRepoNames,
    captureGalleryRepo: deps.captureGalleryRepo ?? defaultCaptureGalleryRepo,
    writeGalleryHtml: deps.writeGalleryHtml ?? defaultWriteGalleryHtml,
    commandRunner: deps.commandRunner ?? runShellCommand,
    discoverAiConfiguredRepoNames: deps.discoverAiConfiguredRepoNames ?? defaultDiscoverAiConfiguredRepoNames,
    ensureAgentSdk: deps.ensureAgentSdk ?? defaultEnsureAgentSdk,
    createExtractionHarness: deps.createExtractionHarness ?? corpusExtractionHarness,
    runAiRepoMatrix: deps.runAiRepoMatrix ?? defaultRunAiRepoMatrix,
    runInstallEval: deps.runInstallEval ?? defaultRunInstallEvalCommand,
  };
}

function parseLayer(value: string | undefined): 1 | 2 | 3 {
  if (value === "1" || value === "2" || value === "3") return Number(value) as 1 | 2 | 3;
  throw new Error(`--layer must be one of 1, 2, or 3; got ${value ?? "nothing"}`);
}

function parseRunArgs(args: readonly string[]): RunCommandOptions {
  const repoNames: string[] = [];
  let layer: 1 | 2 | 3 = 1;
  let json = false;
  let strict = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--layer") {
      layer = parseLayer(args[index + 1]);
      index += 1;
    } else if (arg.startsWith("--layer=")) {
      layer = parseLayer(arg.slice("--layer=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown run option: ${arg}`);
    } else {
      repoNames.push(arg);
    }
  }

  return { repoNames, layer, json, strict };
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value ?? "nothing"}`);
  }
  return parsed;
}

function parseBootArgs(args: readonly string[]): BootCommandOptions {
  const repoNames: string[] = [];
  let timeoutMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(args[index + 1], "--timeout-ms");
      index += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInt(arg.slice("--timeout-ms=".length), "--timeout-ms");
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown boot option: ${arg}`);
    } else {
      repoNames.push(arg);
    }
  }

  if (repoNames.length !== 1) {
    throw new Error(`boot expects exactly one repo name; got ${repoNames.length}`);
  }

  return { repoName: repoNames[0] ?? "", timeoutMs };
}

interface AiCommandOptions {
  repoNames: string[];
  models: string[];
  json: boolean;
  strict: boolean;
}

function parseAiArgs(args: readonly string[]): AiCommandOptions {
  const repoNames: string[] = [];
  const models: string[] = [];
  let json = false;
  let strict = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--model" || arg === "--models") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a model id`);
      models.push(...value.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
      index += 1;
    } else if (arg.startsWith("--model=") || arg.startsWith("--models=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      models.push(...value.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown ai option: ${arg}`);
    } else {
      repoNames.push(arg);
    }
  }

  return {
    repoNames,
    models: models.length > 0 ? models : [DEFAULT_MODEL_LABEL],
    json,
    strict,
  };
}

export function parseInstallEvalArgs(args: readonly string[]): InstallEvalCommandOptions {
  const fixtureNames: string[] = [];
  let model: string = INSTALL_EVAL_DEFAULTS.model;
  let dryRun = false;
  let json = false;
  let strict = false;
  let turnBudget: number = INSTALL_EVAL_DEFAULTS.turnBudget;
  let timeBudgetMs: number = INSTALL_EVAL_DEFAULTS.timeBudgetMs;
  let maxBudgetUsd: number = INSTALL_EVAL_DEFAULTS.maxBudgetUsd;

  const valueOf = (arg: string, next: string | undefined, label: string): string => {
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
    if (!next || next.startsWith("-")) throw new Error(`${label} needs a value`);
    return next;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--model" || arg.startsWith("--model=")) {
      model = valueOf(arg, args[index + 1], "--model");
      if (!arg.includes("=")) index += 1;
    } else if (arg === "--turn-budget" || arg.startsWith("--turn-budget=")) {
      turnBudget = parsePositiveInt(valueOf(arg, args[index + 1], "--turn-budget"), "--turn-budget");
      if (!arg.includes("=")) index += 1;
    } else if (arg === "--time-budget-ms" || arg.startsWith("--time-budget-ms=")) {
      timeBudgetMs = parsePositiveInt(valueOf(arg, args[index + 1], "--time-budget-ms"), "--time-budget-ms");
      if (!arg.includes("=")) index += 1;
    } else if (arg === "--max-budget-usd" || arg.startsWith("--max-budget-usd=")) {
      const value = Number(valueOf(arg, args[index + 1], "--max-budget-usd"));
      if (!Number.isFinite(value) || value <= 0) throw new Error(`--max-budget-usd must be a positive number; got ${value}`);
      maxBudgetUsd = value;
      if (!arg.includes("=")) index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown install-eval option: ${arg}`);
    } else {
      fixtureNames.push(arg);
    }
  }

  return { fixtureNames, model, dryRun, json, strict, turnBudget, timeBudgetMs, maxBudgetUsd };
}

function parseGalleryArgs(args: readonly string[]): GalleryCommandOptions {
  const repoNames: string[] = [];
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") throw new Error(usage);
    if (arg.startsWith("-")) throw new Error(`Unknown gallery option: ${arg}`);
    repoNames.push(arg);
  }
  return { repoNames };
}

function selectedRepos(manifest: CorpusManifest, names: readonly string[]): ManifestEntry[] {
  if (names.length === 0) return [...manifest];
  const byName = new Map(manifest.map((repo) => [repo.name, repo]));
  return names.map((name) => {
    const repo = byName.get(name);
    if (!repo) {
      throw new Error(`Unknown corpus repo "${name}". Known repos: ${manifest.map((entry) => entry.name).join(", ")}`);
    }
    return repo;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined;
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function artifactPaths(artifacts: InitStepArtifacts): string[] {
  return [artifacts.log, artifacts.diff, artifacts.tokenCost].filter((value): value is string => Boolean(value));
}

function bootHandleLogPaths(handle: BootHandle): string[] {
  return [handle.logPaths.server, handle.logPaths.seed, handle.logPaths.database]
    .filter((value): value is string => Boolean(value));
}

function failureLayer(
  layer: number,
  name: string,
  step: string,
  error: unknown,
  logPaths: readonly string[],
): ScorecardLayerInput {
  return {
    layer,
    name,
    status: "fail",
    detail: `${step} failed: ${errorMessage(error)}`,
    logPaths,
    hardFailure: true,
  };
}

function requestedLayers(layer: 1 | 2 | 3): number[] {
  return Array.from({ length: layer }, (_value, index) => index + 1);
}

function layerName(layer: number): string {
  if (layer === 1) return "structural";
  if (layer === 2) return "scored";
  return "e2e";
}

function printBaselineUpdate(
  repo: ManifestEntry,
  update: ScoredLayerRunResult["baselineUpdate"],
  context: CorpusRunContext,
  deps: ResolvedDeps,
  options: RunCommandOptions,
): void {
  if (!update) return;
  const relPath = path.relative(context.corpusRoot, update.path).split(path.sep).join("/");
  const write = options.json ? deps.stderr : deps.stdout;
  write(`Layer 2 baseline candidate for ${repo.name}: ${relPath}`);
  write(update.source.trimEnd());
}

async function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function detectPackageRunner(repoDir: string, packageManager: unknown): Promise<string> {
  if (typeof packageManager === "string") {
    if (packageManager.startsWith("pnpm@")) return "pnpm";
    if (packageManager.startsWith("npm@")) return "npm";
    if (packageManager.startsWith("yarn@")) return "yarn";
    if (packageManager.startsWith("bun@")) return "bun";
  }
  if (await pathExists(path.join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(repoDir, "yarn.lock"))) return "yarn";
  if (await pathExists(path.join(repoDir, "bun.lockb")) || await pathExists(path.join(repoDir, "bun.lock"))) return "bun";
  return "npm";
}

async function detectTypecheckCommand(repoDir: string): Promise<string | undefined> {
  const packageJson = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8")) as unknown;
  if (!isRecord(packageJson)) return undefined;
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  if (typeof scripts.typecheck !== "string") return undefined;

  const runner = await detectPackageRunner(repoDir, packageJson.packageManager);
  if (runner === "npm") return "npm run typecheck";
  if (runner === "bun") return "bun run typecheck";
  return `${runner} typecheck`;
}

function runShellCommand(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<StructuralCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: corpusHostCommandEnv(options.env),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function commandLogLabel(command: string, index: number): string {
  const orderedLabels = ["typecheck", "build"];
  if (orderedLabels[index]) return orderedLabels[index];
  if (/\b(?:typecheck|tsc)\b/.test(command)) return "typecheck";
  if (/\bbuild\b/.test(command)) return "build";
  return `command-${index + 1}`;
}

function createLoggedCommandRunner(
  logsDir: string,
  logPrefix: string,
  commandRunner: StructuralCommandRunner,
): LoggedCommandRunner {
  const logPaths: string[] = [];
  let commandIndex = 0;

  return {
    logPaths,
    async runner(command, options) {
      const label = commandLogLabel(command, commandIndex);
      commandIndex += 1;
      const stdoutPath = path.join(logsDir, `${logPrefix}.${label}.stdout.log`);
      const stderrPath = path.join(logsDir, `${logPrefix}.${label}.stderr.log`);
      await mkdir(logsDir, { recursive: true });
      try {
        const result = await commandRunner(command, options);
        await writeFile(stdoutPath, result.stdout);
        await writeFile(stderrPath, result.stderr);
        logPaths.push(stdoutPath, stderrPath);
        return result;
      } catch (error) {
        await writeFile(stdoutPath, "");
        await writeFile(stderrPath, errorMessage(error));
        logPaths.push(stdoutPath, stderrPath);
        throw error;
      }
    },
  };
}

async function captureBaselineCommand(
  command: string | undefined,
  repoDir: string,
  env: NodeJS.ProcessEnv | undefined,
  runner: StructuralCommandRunner,
): Promise<StructuralCommandSnapshot | undefined> {
  if (!command) return undefined;
  try {
    return {
      command,
      result: await runner(command, { cwd: repoDir, env }),
    };
  } catch (error) {
    return {
      command,
      error: errorMessage(error),
    };
  }
}

async function captureHostBaseline(
  repoDir: string,
  typecheckCommand: string | undefined,
  buildCommand: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  runner: StructuralCommandRunner,
): Promise<StructuralHostBaseline> {
  const typecheck = await captureBaselineCommand(typecheckCommand, repoDir, env, runner);
  const build = await captureBaselineCommand(buildCommand, repoDir, env, runner);
  return { typecheck, build };
}

async function runRepoThroughLayerOne(
  repo: ManifestEntry,
  options: RunCommandOptions,
  context: CorpusRunContext,
  injector: LocalVendoInjector,
  deps: ResolvedDeps,
): Promise<ScorecardRepoInput> {
  const logPaths: string[] = [];

  try {
    const checkoutDir = await deps.ensureRepoCheckout(repo, { context, workspaceRoot: deps.workspaceRoot });
    const appRoot = resolveAppRoot(repo, checkoutDir);
    const bootstrap = await deps.bootstrapRepo(repo, { context, env: deps.env });
    logPaths.push(bootstrap.logs.stdout, bootstrap.logs.stderr);

    const injectResult = await injector.inject(repo);
    const typecheckCommand = repo.bootstrap.typecheckCommand ?? await detectTypecheckCommand(appRoot);
    const buildCommand = repo.bootstrap.buildCommand;
    const baselineCommands = createLoggedCommandRunner(context.logsDir(repo.name), "baseline", deps.commandRunner);
    const baseline = await captureHostBaseline(
      appRoot,
      typecheckCommand,
      buildCommand,
      deps.env,
      baselineCommands.runner,
    );
    logPaths.push(...baselineCommands.logPaths);

    const initOptions: RunVendoInitStepOptions = {
      context,
      env: deps.env,
    };
    const firstInit = await deps.runInit(repo, { ...initOptions, artifactPrefix: "init.first" });
    logPaths.push(...artifactPaths(firstInit.artifacts));
    const secondInit = await deps.runInit(repo, { ...initOptions, artifactPrefix: "init.second", diffBase: "pre-run" });
    logPaths.push(...artifactPaths(secondInit.artifacts));

    const loggedCommands = createLoggedCommandRunner(context.logsDir(repo.name), "structural", deps.commandRunner);
    const checks = await deps.runStructuralLayer({
      repoDir: appRoot,
      initExitCode: firstInit.exitCode,
      initDetail: await readOptional(firstInit.artifacts.log),
      secondInitExitCode: secondInit.exitCode,
      secondRunDiff: await readOptional(secondInit.artifacts.diff),
      secondRunDetail: await readOptional(secondInit.artifacts.log),
      typecheckCommand,
      buildCommand,
      baseline,
      commandRunner: loggedCommands.runner,
      env: deps.env,
      framework: repo.framework ?? "next",
    });

    const layers: ScorecardLayerInput[] = [
      {
        layer: 1,
        name: "structural",
        checks,
        logPaths: [...logPaths, ...loggedCommands.logPaths],
      },
    ];

    if (requestedLayers(options.layer).includes(2)) {
      try {
        const scored = await deps.runScoredLayer({
          repoName: repo.name,
          repoDir: appRoot,
          expectationsRoot: path.join(context.corpusRoot, "expectations"),
          now: deps.now,
        });
        layers.push(scored.layer);
        printBaselineUpdate(repo, scored.baselineUpdate, context, deps, options);
      } catch (error) {
        layers.push(failureLayer(2, "scored", "scored layer", error, logPaths));
      }
    }

    if (requestedLayers(options.layer).includes(3)) {
      if (repo.tier !== "deep") {
        layers.push({
          layer: 3,
          name: layerName(3),
          status: "skip",
          detail: "Layer 3 is deep-tier only.",
          logPaths,
          hardFailure: false,
        });
      } else {
        let handle: BootHandle | undefined;
        let layer: ScorecardLayerInput | undefined;
        const layerLogPaths = [...logPaths];
        try {
          layerLogPaths.push(...await deps.prepareE2eRepo(repo, appRoot, context.logsDir(repo.name)));
          handle = await deps.bootRepo(repo, {
            context,
            env: deps.env,
          });
          layerLogPaths.push(...bootHandleLogPaths(handle));
          const doctor = repo.framework === "express"
            ? await deps.runLiveDoctor({
                workspaceRoot: deps.workspaceRoot ?? defaultWorkspaceRoot,
                appRoot,
                readinessUrl: handle.readinessUrl,
                logsDir: context.logsDir(repo.name),
                env: deps.env,
              })
            : undefined;
          if (doctor) layerLogPaths.push(doctor.logPath);
          const e2e = await deps.runE2eLayer({
            repoName: repo.name,
            repoDir: appRoot,
            readinessUrl: handle.readinessUrl,
            expectationsRoot: path.join(context.corpusRoot, "expectations"),
            logsDir: context.logsDir(repo.name),
            now: deps.now,
          });
          layer = {
            ...e2e.layer,
            ...(doctor && !doctor.check.pass ? { status: "fail" as const, hardFailure: true } : {}),
            checks: [...(e2e.layer.checks ?? []), ...(doctor ? [doctor.check] : [])],
            logPaths: [...layerLogPaths, ...(e2e.layer.logPaths ?? [])],
          };
        } catch (error) {
          layer = failureLayer(3, "e2e", "e2e layer", error, layerLogPaths);
        } finally {
          if (handle) {
            try {
              await handle.teardown();
            } catch (error) {
              layer = failureLayer(3, "e2e", "e2e teardown", error, layerLogPaths);
            }
          }
        }
        if (!layer) {
          layer = failureLayer(3, "e2e", "e2e layer", "Layer 3 did not produce a result.", layerLogPaths);
        }
        layers.push(layer);
      }
    }

    return { repo: repo.name, layers };
  } catch (error) {
    return {
      repo: repo.name,
      layers: [failureLayer(1, "structural", "runner", error, logPaths)],
    };
  }
}

async function runSweep(options: RunCommandOptions, deps: ResolvedDeps): Promise<number> {
  const manifest = await deps.loadManifest();
  const repos = selectedRepos(manifest, options.repoNames);
  const context = deps.createContext();
  const injector = deps.createInjector({ context, workspaceRoot: deps.workspaceRoot });
  const repoResults: ScorecardRepoInput[] = [];

  for (const repo of repos) {
    repoResults.push(await runRepoThroughLayerOne(repo, options, context, injector, deps));
  }

  const scorecard = buildScorecard({
    generatedAt: deps.now().toISOString(),
    strict: options.strict,
    repos: repoResults,
  });
  await writeScorecardArtifacts(scorecard, { context });

  if (options.json) {
    deps.stdout(JSON.stringify(scorecard, null, 2));
  } else {
    deps.stdout(renderScorecardMarkdown(scorecard, { linkBaseDir: context.corpusRoot }));
  }

  return scorecardExitCode(scorecard);
}

async function runBootCommand(options: BootCommandOptions, deps: ResolvedDeps): Promise<number> {
  const manifest = await deps.loadManifest();
  const repo = selectedRepos(manifest, [options.repoName])[0];
  if (!repo) throw new Error(`Unknown corpus repo "${options.repoName}"`);

  const context = deps.createContext();
  const injector = deps.createInjector({ context, workspaceRoot: deps.workspaceRoot });
  await deps.ensureRepoCheckout(repo, { context, workspaceRoot: deps.workspaceRoot });
  await deps.bootstrapRepo(repo, { context, env: deps.env });

  const injectResult = await injector.inject(repo);
  const init = await deps.runInit(repo, {
    context,
    env: deps.env,
    artifactPrefix: "boot.init",
  });
  if (init.exitCode !== 0) {
    throw new Error(`vendo init failed for ${repo.name}; see ${init.artifacts.log}`);
  }
  await deps.prepareE2eRepo(repo, injectResult.repoDir, context.logsDir(repo.name));

  const handle = await deps.bootRepo(repo, {
    context,
    env: deps.env,
    readinessTimeoutMs: options.timeoutMs,
  });

  deps.stdout(`Booted ${repo.name} at ${handle.readinessUrl}`);
  deps.stdout(`Server log: ${path.relative(context.corpusRoot, handle.logPaths.server)}`);
  try {
    await deps.waitForBootShutdown(handle, repo);
  } finally {
    await handle.teardown();
  }

  return 0;
}

async function runGalleryCommand(options: GalleryCommandOptions, deps: ResolvedDeps): Promise<number> {
  const manifest = await deps.loadManifest();
  const context = deps.createContext();
  const expectationsRoot = path.join(context.corpusRoot, "expectations");
  const repoNames = options.repoNames.length > 0
    ? options.repoNames
    : await deps.discoverConfiguredGalleryRepoNames(expectationsRoot);
  if (repoNames.length === 0) {
    throw new Error("No corpus gallery configs found. Add corpus/expectations/<repo>/gallery.json or pass repo names explicitly.");
  }
  const repos = selectedRepos(manifest, repoNames);
  for (const repo of repos) {
    if (repo.tier !== "deep") {
      throw new Error(`gallery requires a deep-tier boot recipe; ${repo.name} is ${repo.tier}-tier.`);
    }
  }

  const generatedAt = deps.now().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replace(".", "-");
  const runRoot = path.join(context.reposDir, ".gallery", runId);
  await mkdir(runRoot, { recursive: true });
  const injector = deps.createInjector({ context, workspaceRoot: deps.workspaceRoot });
  const results: GalleryRepoResult[] = [];

  for (const repo of repos) {
    let handle: BootHandle | undefined;
    let result: GalleryRepoResult | undefined;
    let failure: string | undefined;
    try {
      const checkoutDir = await deps.ensureRepoCheckout(repo, { context, workspaceRoot: deps.workspaceRoot });
      const appRoot = resolveAppRoot(repo, checkoutDir);
      await deps.bootstrapRepo(repo, { context, env: deps.env });
      await injector.inject(repo);
      const init = await deps.runInit(repo, {
        context,
        env: deps.env,
        artifactPrefix: "gallery.init",
      });
      if (init.exitCode !== 0) {
        throw new Error(`vendo init failed for ${repo.name}; see ${init.artifacts.log}`);
      }
      await deps.prepareE2eRepo(repo, appRoot, context.logsDir(repo.name));
      // Build only when the dev server serves prebuilt output (manifest
      // devServer.requiresBuild). Self-compiling dev servers boot without a
      // production build — same seam `corpus boot` and Layer 3 have always
      // used — and papermark's upstream baseline build is broken at the pin
      // (layers 1-2 record it as skipped-baseline-broken).
      if (repo.bootstrap.buildCommand && repo.bootstrap.devServer?.requiresBuild === true) {
        const build = createLoggedCommandRunner(
          context.logsDir(repo.name),
          "gallery.build",
          deps.commandRunner,
        );
        const buildResult = await build.runner(repo.bootstrap.buildCommand, {
          cwd: appRoot,
          env: deps.env,
        });
        if (buildResult.code !== 0) {
          throw new Error(
            `gallery build failed for ${repo.name} with exit code ${buildResult.code ?? "unknown"}; see ${build.logPaths.join(", ")}`,
          );
        }
      }
      handle = await deps.bootRepo(repo, { context, env: deps.env });
      result = await deps.captureGalleryRepo({
        repoName: repo.name,
        readinessUrl: handle.readinessUrl,
        expectationsRoot,
        runRoot,
      });
    } catch (error) {
      failure = errorMessage(error);
      deps.stderr(`Gallery capture failed for ${repo.name}: ${failure}`);
    } finally {
      if (handle) {
        try {
          await handle.teardown();
        } catch (error) {
          failure = `teardown failed: ${errorMessage(error)}`;
          deps.stderr(`Gallery teardown failed for ${repo.name}: ${errorMessage(error)}`);
        }
      }
    }
    results.push(failure
      ? { repoName: repo.name, nativeScreens: [], prompts: [], error: failure }
      : result ?? { repoName: repo.name, nativeScreens: [], prompts: [], error: "capture produced no result" });
  }

  const galleryPath = await deps.writeGalleryHtml({
    runId,
    runRoot,
    generatedAt,
    repos: results,
  });
  deps.stdout(`Gallery: ${galleryPath}`);
  return results.some((result) => result.error) ? 1 : 0;
}

async function runAiCommand(options: AiCommandOptions, deps: ResolvedDeps): Promise<number> {
  const manifest = await deps.loadManifest();
  const context = deps.createContext();
  const expectationsRoot = path.join(context.corpusRoot, "expectations");
  const env = (deps.env ?? process.env) as Record<string, string | undefined>;

  const repoNames = options.repoNames.length > 0
    ? options.repoNames
    : await deps.discoverAiConfiguredRepoNames(expectationsRoot);
  if (repoNames.length === 0) {
    throw new Error("No AI-labeled corpus repos found. Add corpus/expectations/<repo>/ai-expected.json or pass repo names explicitly.");
  }
  const repos = selectedRepos(manifest, repoNames);

  // Fail fast, never hang: the matrix runs a real model and is useless
  // without the SDK and a credential. The SDK lives in a gitignored cache,
  // never in the workspace (the dev-riders host-only resolution doctrine).
  const sdkDir = agentSdkDir(context.reposDir);
  await deps.ensureAgentSdk(sdkDir);
  const harness = deps.createExtractionHarness(sdkDir);
  const credential = await harness.availability({ root: deps.workspaceRoot ?? defaultWorkspaceRoot, env });
  if (credential === null) {
    deps.stderr("The AI extraction matrix needs a real model credential and cannot run without one.");
    deps.stderr("Set ANTHROPIC_API_KEY in the environment or log into Claude Code (`claude login`), then re-run `pnpm corpus ai`.");
    return 1;
  }
  const progress = options.json ? deps.stderr : deps.stdout;
  progress(`AI extraction matrix: ${repos.length} repo(s) × ${options.models.length} model(s), credential: ${credential}.`);

  const injector = deps.createInjector({ context, workspaceRoot: deps.workspaceRoot });
  const results: AiRepoResult[] = [];
  for (const repo of repos) {
    try {
      const checkoutDir = await deps.ensureRepoCheckout(repo, { context, workspaceRoot: deps.workspaceRoot });
      const appRoot = resolveAppRoot(repo, checkoutDir);
      await deps.bootstrapRepo(repo, { context, env: deps.env });
      await injector.inject(repo);
      const init = await deps.runInit(repo, { context, env: deps.env, artifactPrefix: "ai.init" });
      if (init.exitCode !== 0) {
        throw new Error(`vendo init failed for ${repo.name}; see ${init.artifacts.log}`);
      }
      results.push(await deps.runAiRepoMatrix({
        repoName: repo.name,
        appRoot,
        expectationsRoot,
        models: options.models,
        aiLogsDir: path.join(context.logsDir(repo.name), "ai"),
        env,
        harness,
        onProgress: progress,
      }));
    } catch (error) {
      deps.stderr(`AI matrix failed for ${repo.name}: ${errorMessage(error)}`);
      results.push({ repo: repo.name, failure: errorMessage(error), labeled: false, models: [] });
    }
  }

  const scoreboard = buildAiScoreboard({
    generatedAt: deps.now().toISOString(),
    models: options.models,
    repos: results,
  });
  const artifacts = await writeAiScoreboardArtifacts(scoreboard, {
    logsRoot: path.join(context.reposDir, ".logs"),
  });

  if (options.json) {
    deps.stdout(JSON.stringify(scoreboard, null, 2));
  } else {
    deps.stdout(renderAiScoreboardMarkdown(scoreboard));
    deps.stdout(`Scoreboard: ${artifacts.markdown}`);
  }

  return options.strict && scoreboard.summary.failedRuns > 0 ? 1 : 0;
}

function waitForBootShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const cleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    };
    const onSignal = () => {
      cleanup();
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export async function runCli(args = process.argv.slice(2), providedDeps: CorpusCliDependencies = {}): Promise<number> {
  const deps = resolveDeps(providedDeps);
  const command = args[0];

  try {
    if (!command || command === "--help" || command === "-h") {
      deps.stdout(usage);
      return 0;
    }

    if (command === "validate") {
      const manifest = await deps.loadManifest();
      deps.stdout(`Loaded ${manifest.length} corpus repos from corpus/manifest.json.`);
      return 0;
    }

    if (command === "list") {
      const manifest = await deps.loadManifest();
      for (const repo of manifest) {
        deps.stdout(`${repo.name}\t${repo.tier}\t${repo.localPath ?? repo.pinnedSha}`);
      }
      return 0;
    }

    if (command === "run") {
      return await runSweep(parseRunArgs(args.slice(1)), deps);
    }

    if (command === "boot") {
      return await runBootCommand(parseBootArgs(args.slice(1)), deps);
    }

    if (command === "gallery") {
      return await runGalleryCommand(parseGalleryArgs(args.slice(1)), deps);
    }

    if (command === "ai") {
      return await runAiCommand(parseAiArgs(args.slice(1)), deps);
    }

    if (command === "install-eval") {
      const options = parseInstallEvalArgs(args.slice(1));
      return await deps.runInstallEval(options, {
        stdout: deps.stdout,
        stderr: deps.stderr,
        now: deps.now,
        env: (deps.env ?? process.env) as NodeJS.ProcessEnv,
        workspaceRoot: deps.workspaceRoot ?? defaultWorkspaceRoot,
        context: deps.createContext(),
      });
    }

    deps.stderr(`Unknown corpus command: ${command}`);
    deps.stderr(usage);
    return 1;
  } catch (error) {
    deps.stderr(errorMessage(error));
    return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
