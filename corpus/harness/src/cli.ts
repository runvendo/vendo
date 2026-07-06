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
  buildScorecard,
  renderScorecardMarkdown,
  scorecardExitCode,
  writeScorecardArtifacts,
  type ScorecardLayerInput,
  type ScorecardRepoInput,
} from "./scorecard.js";

const usage = `Usage:
  pnpm corpus --help
  pnpm corpus validate
  pnpm corpus list
  pnpm corpus run [repo...] --layer <1|2|3> [--json] [--strict] [--skip-llm]
  pnpm corpus boot <repo> [--skip-llm] [--timeout-ms <ms>]

Commands:
  validate  Load and validate corpus/manifest.json.
  list      Print manifest repo names with tier and pinned SHA.
  run       Clone, bootstrap, inject local Vendo, run init, and execute selected layers.
  boot      Clone, bootstrap, inject local Vendo, run init, boot one deep-tier app, and wait for Ctrl-C.
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
  runE2eLayer?: (ctx: E2eLayerContext) => Promise<E2eLayerRunResult>;
  commandRunner?: StructuralCommandRunner;
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
  runE2eLayer: (ctx: E2eLayerContext) => Promise<E2eLayerRunResult>;
  commandRunner: StructuralCommandRunner;
}

interface RunCommandOptions {
  repoNames: string[];
  layer: 1 | 2 | 3;
  json: boolean;
  strict: boolean;
  skipLlm: boolean;
}

interface BootCommandOptions {
  repoName: string;
  skipLlm: boolean;
  timeoutMs?: number;
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
    runE2eLayer: deps.runE2eLayer ?? defaultRunE2eLayer,
    commandRunner: deps.commandRunner ?? runShellCommand,
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
  let skipLlm = false;

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
    } else if (arg === "--skip-llm") {
      skipLlm = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown run option: ${arg}`);
    } else {
      repoNames.push(arg);
    }
  }

  return { repoNames, layer, json, strict, skipLlm };
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
  let skipLlm = false;
  let timeoutMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--skip-llm") {
      skipLlm = true;
    } else if (arg === "--timeout-ms") {
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

  return { repoName: repoNames[0] ?? "", skipLlm, timeoutMs };
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

function localVendoDirFromInitArgs(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--local") return args[index + 1];
    if (arg?.startsWith("--local=")) return arg.slice("--local=".length);
  }
  return undefined;
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
      env: { ...process.env, ...options.env },
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
    const checkoutDir = await deps.ensureRepoCheckout(repo, { context });
    const appRoot = resolveAppRoot(repo, checkoutDir);
    const bootstrap = await deps.bootstrapRepo(repo, { context, env: deps.env });
    logPaths.push(bootstrap.logs.stdout, bootstrap.logs.stderr);

    const injectResult = await injector.inject(repo);
    const localVendoDir = localVendoDirFromInitArgs(injectResult.initArgs.length > 0 ? injectResult.initArgs : injector.initArgs());
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
      localVendoDir,
      skipLlm: options.skipLlm ? true : false,
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
          handle = await deps.bootRepo(repo, {
            context,
            env: deps.env,
          });
          layerLogPaths.push(...bootHandleLogPaths(handle));
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
  await deps.ensureRepoCheckout(repo, { context });
  await deps.bootstrapRepo(repo, { context, env: deps.env });

  const injectResult = await injector.inject(repo);
  const localVendoDir = localVendoDirFromInitArgs(injectResult.initArgs.length > 0 ? injectResult.initArgs : injector.initArgs());
  const init = await deps.runInit(repo, {
    context,
    env: deps.env,
    localVendoDir,
    skipLlm: options.skipLlm ? true : false,
    artifactPrefix: "boot.init",
  });
  if (init.exitCode !== 0) {
    throw new Error(`vendo init failed for ${repo.name}; see ${init.artifacts.log}`);
  }

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
        deps.stdout(`${repo.name}\t${repo.tier}\t${repo.pinnedSha}`);
      }
      return 0;
    }

    if (command === "run") {
      return await runSweep(parseRunArgs(args.slice(1)), deps);
    }

    if (command === "boot") {
      return await runBootCommand(parseBootArgs(args.slice(1)), deps);
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
