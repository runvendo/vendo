import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapRepo as defaultBootstrapRepo,
  type BootstrapOptions,
  type BootstrapResult,
} from "./bootstrap.js";
import { resolveAppRoot } from "./app-root.js";
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
  applyVendoRootPaste as defaultApplyVendoRootPaste,
  type VendoRootPasteResult,
} from "./vendo-root-paste.js";
import { runHostCommand } from "./process.js";
import { errorMessage, isRecord, pathExists, readOptional } from "./util.js";

const usage = `Usage:
  pnpm corpus --help
  pnpm corpus validate
  pnpm corpus list
  pnpm corpus run [repo...] --layer <1|2> [--json] [--strict]
  pnpm corpus ai [repo...] [--model <id>]... [--json] [--strict]

Commands:
  validate  Load and validate corpus/manifest.json.
  list      Print manifest repo names with tier and source revision/path.
  run       Clone, bootstrap, inject local Vendo, run init, and execute selected layers.
  ai        Run the judgment-channel matrix (repo × model) and score against ai-expected.json labels.
            Needs a real model credential (ANTHROPIC_API_KEY or a Claude Code login); never part of pnpm test.
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
  applyVendoRootPaste?: (
    repoDir: string,
    framework: "next" | "express" | undefined,
  ) => Promise<VendoRootPasteResult>;
  runStructuralLayer?: (ctx: StructuralLayerContext) => Promise<StructuralCheckResult[]>;
  runScoredLayer?: (ctx: ScoredLayerContext) => Promise<ScoredLayerRunResult>;
  commandRunner?: StructuralCommandRunner;
  discoverAiConfiguredRepoNames?: (expectationsRoot: string) => Promise<string[]>;
  ensureAgentSdk?: (sdkDir: string) => Promise<void>;
  createExtractionHarness?: (sdkDir: string) => ExtractionHarness;
  runAiRepoMatrix?: (options: RunAiRepoMatrixOptions) => Promise<AiRepoResult>;
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
  applyVendoRootPaste: (
    repoDir: string,
    framework: "next" | "express" | undefined,
  ) => Promise<VendoRootPasteResult>;
  runStructuralLayer: (ctx: StructuralLayerContext) => Promise<StructuralCheckResult[]>;
  runScoredLayer: (ctx: ScoredLayerContext) => Promise<ScoredLayerRunResult>;
  commandRunner: StructuralCommandRunner;
  discoverAiConfiguredRepoNames: (expectationsRoot: string) => Promise<string[]>;
  ensureAgentSdk: (sdkDir: string) => Promise<void>;
  createExtractionHarness: (sdkDir: string) => ExtractionHarness;
  runAiRepoMatrix: (options: RunAiRepoMatrixOptions) => Promise<AiRepoResult>;
}

interface RunCommandOptions {
  repoNames: string[];
  layer: 1 | 2;
  json: boolean;
  strict: boolean;
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
    applyVendoRootPaste: deps.applyVendoRootPaste ?? defaultApplyVendoRootPaste,
    runStructuralLayer: deps.runStructuralLayer ?? defaultRunStructuralLayer,
    runScoredLayer: deps.runScoredLayer ?? defaultRunScoredLayer,
    commandRunner: deps.commandRunner ?? runHostCommand,
    discoverAiConfiguredRepoNames: deps.discoverAiConfiguredRepoNames ?? defaultDiscoverAiConfiguredRepoNames,
    ensureAgentSdk: deps.ensureAgentSdk ?? defaultEnsureAgentSdk,
    createExtractionHarness: deps.createExtractionHarness ?? corpusExtractionHarness,
    runAiRepoMatrix: deps.runAiRepoMatrix ?? defaultRunAiRepoMatrix,
  };
}

function parseLayer(value: string | undefined): 1 | 2 {
  if (value === "1" || value === "2") return Number(value) as 1 | 2;
  throw new Error(`--layer must be one of 1 or 2; got ${value ?? "nothing"}`);
}

function parseRunArgs(args: readonly string[]): RunCommandOptions {
  const repoNames: string[] = [];
  let layer: 1 | 2 = 1;
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

function artifactPaths(artifacts: InitStepArtifacts): string[] {
  return [artifacts.log, artifacts.diff, artifacts.tokenCost].filter((value): value is string => Boolean(value));
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

/** Checkout, resolve the app root, bootstrap, and inject the local Vendo build:
 *  everything every command needs in place before `vendo init` can run. */
async function prepareRepo(
  repo: ManifestEntry,
  context: CorpusRunContext,
  injector: LocalVendoInjector,
  deps: ResolvedDeps,
): Promise<{ appRoot: string; bootstrap: BootstrapResult }> {
  const checkoutDir = await deps.ensureRepoCheckout(repo, { context, workspaceRoot: deps.workspaceRoot });
  const appRoot = resolveAppRoot(repo, checkoutDir);
  const bootstrap = await deps.bootstrapRepo(repo, { context, env: deps.env });
  await injector.inject(repo);
  return { appRoot, bootstrap };
}

/** Run init once and refuse to continue on a failure. The sweep does NOT use
 *  this: it runs init twice with AI polish on and feeds a non-zero exit code to
 *  the structural layer as a finding rather than throwing. */
async function runCheckedInit(
  repo: ManifestEntry,
  context: CorpusRunContext,
  deps: ResolvedDeps,
  artifactPrefix: string,
): Promise<InitStepResult> {
  const init = await deps.runInit(repo, { context, env: deps.env, artifactPrefix });
  if (init.exitCode !== 0) {
    throw new Error(`vendo init failed for ${repo.name}; see ${init.artifacts.log}`);
  }
  return init;
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
    const { appRoot, bootstrap } = await prepareRepo(repo, context, injector, deps);
    logPaths.push(bootstrap.logs.stdout, bootstrap.logs.stderr);

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
      // Consent to init's AI extraction pass (theme stage's LLM fallback
      // lives behind this gate now). The workflow's key/binary availability
      // decides whether the pass actually runs; init degrades gracefully
      // without them, so this is safe to leave on unconditionally.
      aiPolish: true,
    };
    const firstInit = await deps.runInit(repo, { ...initOptions, artifactPrefix: "init.first" });
    logPaths.push(...artifactPaths(firstInit.artifacts));
    if (firstInit.exitCode === 0) {
      await deps.applyVendoRootPaste(appRoot, repo.framework);
    }
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

    if (options.layer === 2) {
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
  // never in the workspace (the host-only SDK resolution doctrine).
  const sdkDir = agentSdkDir(context.reposDir);
  await deps.ensureAgentSdk(sdkDir);
  const harness = deps.createExtractionHarness(sdkDir);
  const credential = await harness.availability({ root: deps.workspaceRoot ?? defaultWorkspaceRoot, env });
  if (credential === null) {
    deps.stderr("The judgment-channel matrix needs a real model credential and cannot run without one.");
    deps.stderr("Set ANTHROPIC_API_KEY in the environment or log into Claude Code (`claude login`), then re-run `pnpm corpus ai`.");
    return 1;
  }
  const progress = options.json ? deps.stderr : deps.stdout;
  progress(`Judgment channel matrix: ${repos.length} repo(s) × ${options.models.length} model(s), credential: ${credential}.`);

  const injector = deps.createInjector({ context, workspaceRoot: deps.workspaceRoot });
  const results: AiRepoResult[] = [];
  for (const repo of repos) {
    try {
      const { appRoot } = await prepareRepo(repo, context, injector, deps);
      await runCheckedInit(repo, context, deps, "ai.init");
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
      deps.stderr(`Judgment matrix failed for ${repo.name}: ${errorMessage(error)}`);
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

    if (command === "ai") {
      return await runAiCommand(parseAiArgs(args.slice(1)), deps);
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
