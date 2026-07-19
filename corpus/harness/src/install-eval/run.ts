import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CorpusRunContext } from "../run-context.js";
import { runInstallAgent, type InstallAgentResult, type RunInstallAgentOptions } from "./agent.js";
import { runFixtureDoctor, type RunFixtureDoctorOptions } from "./doctor.js";
import {
  prepareFixture,
  readFinalToolState,
  selectFixtures,
  type InstallEvalFixture,
  type PrepareFixtureOptions,
} from "./fixtures.js";
import { packWorkspaceVendoTarballs, type PackWorkspaceVendoTarballsOptions } from "./pack.js";
import { INSTALL_MDX_RELATIVE_PATH, readNorthStarPrompt } from "./prompt.js";
import {
  indexLocalTarballs,
  startLocalNpmRegistry,
  type LocalNpmRegistry,
  type StartLocalNpmRegistryOptions,
} from "./registry.js";
import {
  buildInstallEvalReport,
  renderInstallEvalMarkdown,
  writeInstallEvalReport,
  type InstallEvalReportDocument,
} from "./report.js";
import { scoreFixtureRun, type DoctorOutcome, type FixtureRunMetrics } from "./score.js";
import { parseTranscript } from "./transcript.js";

/**
 * `pnpm corpus install-eval` — the agent-install eval (plan Phase 4). For
 * each fixture: clean copy, local-registry npm resolution, one REAL headless
 * Claude Code run with only the docs' copy-paste prompt, then machine
 * scoring (doctor run by the harness, transcript heuristics) and a matrix
 * report under corpus/reports/.
 *
 * NEVER in CI or `pnpm test`: every live run spends real model money. The
 * --dry-run mode exercises the entire pipeline against a canned transcript
 * without invoking the agent (and without doctor, which would need the
 * agent's install to exist).
 */

export interface InstallEvalCommandOptions {
  fixtureNames: string[];
  model: string;
  dryRun: boolean;
  json: boolean;
  strict: boolean;
  turnBudget: number;
  timeBudgetMs: number;
  maxBudgetUsd: number;
}

export const INSTALL_EVAL_DEFAULTS = {
  model: "sonnet",
  turnBudget: 40,
  timeBudgetMs: 20 * 60_000,
  maxBudgetUsd: 10,
} as const;

const cannedDir = fileURLToPath(new URL("../../test/fixtures/install-eval/", import.meta.url));
export const CANNED_TRANSCRIPT_PATH = path.join(cannedDir, "canned-transcript.jsonl");
export const CANNED_DOCTOR_PATH = path.join(cannedDir, "canned-doctor.json");

export interface InstallEvalDeps {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
  context: CorpusRunContext;
  readPrompt?: (workspaceRoot: string) => Promise<string>;
  packTarballs?: (options: PackWorkspaceVendoTarballsOptions) => Promise<string>;
  startRegistry?: (options: StartLocalNpmRegistryOptions) => Promise<LocalNpmRegistry>;
  prepare?: (options: PrepareFixtureOptions) => Promise<string>;
  runAgent?: (options: RunInstallAgentOptions) => Promise<InstallAgentResult>;
  runDoctor?: (options: RunFixtureDoctorOptions) => Promise<DoctorOutcome>;
  readToolState?: (fixtureDir: string) => Promise<{ toolNames: string[]; referencedToolNames: string[] }>;
  writeReport?: (doc: InstallEvalReportDocument, options: { reportsDir: string }) => Promise<{ json: string; markdown: string }>;
}

async function readCannedDoctor(): Promise<DoctorOutcome> {
  return JSON.parse(await readFile(CANNED_DOCTOR_PATH, "utf8")) as DoctorOutcome;
}

type ResolvedInstallEvalDeps = InstallEvalDeps & Required<Pick<
  InstallEvalDeps,
  "readPrompt" | "packTarballs" | "startRegistry" | "prepare" | "runAgent" | "runDoctor" | "readToolState" | "writeReport"
>>;

async function runOneFixture(
  fixture: InstallEvalFixture,
  options: InstallEvalCommandOptions,
  registryUrl: string,
  prompt: string,
  deps: ResolvedInstallEvalDeps,
  fixturesRoot: string,
): Promise<FixtureRunMetrics> {
  const progress = options.json ? deps.stderr : deps.stdout;
  progress(`install-eval: preparing fixture ${fixture.name}…`);
  const fixtureDir = await deps.prepare({
    fixture,
    workspaceRoot: deps.workspaceRoot,
    fixturesRoot,
    registryUrl,
  });
  const logsDir = deps.context.logsDir(fixture.name);
  const transcriptPath = path.join(logsDir, "install-eval.transcript.jsonl");

  let agentExit: { code: number | null; timedOut: boolean };
  let transcriptSource: string;
  let doctor: DoctorOutcome;

  if (options.dryRun) {
    transcriptSource = await readFile(CANNED_TRANSCRIPT_PATH, "utf8");
    agentExit = { code: 0, timedOut: false };
    doctor = await readCannedDoctor();
    progress(`install-eval: ${fixture.name} dry run — scored canned transcript, doctor skipped.`);
  } else {
    progress(`install-eval: ${fixture.name} — running headless agent (model ${options.model}, `
      + `budget $${options.maxBudgetUsd} / ${Math.round(options.timeBudgetMs / 60_000)}min)…`);
    const agent = await deps.runAgent({
      prompt,
      cwd: fixtureDir,
      transcriptPath,
      model: options.model,
      maxBudgetUsd: options.maxBudgetUsd,
      timeBudgetMs: options.timeBudgetMs,
      env: deps.env,
    });
    agentExit = { code: agent.code, timedOut: agent.timedOut };
    transcriptSource = await readFile(transcriptPath, "utf8");
    progress(`install-eval: ${fixture.name} — agent exited ${agent.code ?? "by signal"}${agent.timedOut ? " (time budget hit)" : ""}; running doctor…`);
    doctor = await deps.runDoctor({ fixture, fixtureDir, logsDir, env: deps.env });
  }

  const events = parseTranscript(transcriptSource);
  const finalToolState = options.dryRun
    ? { toolNames: [], referencedToolNames: [] }
    : await deps.readToolState(fixtureDir);

  return scoreFixtureRun({
    fixture: fixture.name,
    events,
    doctor,
    finalToolState,
    turnBudget: options.turnBudget,
    agentExit,
  });
}

export async function runInstallEvalCommand(options: InstallEvalCommandOptions, deps: InstallEvalDeps): Promise<number> {
  const resolved = {
    ...deps,
    readPrompt: deps.readPrompt ?? readNorthStarPrompt,
    packTarballs: deps.packTarballs ?? packWorkspaceVendoTarballs,
    startRegistry: deps.startRegistry ?? startLocalNpmRegistry,
    prepare: deps.prepare ?? prepareFixture,
    runAgent: deps.runAgent ?? runInstallAgent,
    runDoctor: deps.runDoctor ?? runFixtureDoctor,
    readToolState: deps.readToolState ?? readFinalToolState,
    writeReport: deps.writeReport ?? writeInstallEvalReport,
  };
  const progress = options.json ? deps.stderr : deps.stdout;
  const fixtures = selectFixtures(options.fixtureNames);
  const prompt = await resolved.readPrompt(deps.workspaceRoot);

  const tarballDir = path.join(deps.context.reposDir, ".install-eval-tarballs");
  await mkdir(tarballDir, { recursive: true });
  await resolved.packTarballs({
    workspaceRoot: deps.workspaceRoot,
    cacheDir: tarballDir,
    log: progress,
  });
  const registry = await resolved.startRegistry({
    tarballDir,
    packages: await indexLocalTarballs(tarballDir),
  });
  progress(`install-eval: local npm registry at ${registry.url} (Vendo packages local, everything else redirects upstream).`);

  const generatedAt = deps.now().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replace(".", "-");
  const fixturesRoot = path.join(deps.context.reposDir, ".install-eval");
  const results: FixtureRunMetrics[] = [];
  try {
    for (const fixture of fixtures) {
      try {
        results.push(await runOneFixture(fixture, options, registry.url, prompt, resolved, fixturesRoot));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.stderr(`install-eval: ${fixture.name} failed: ${message}`);
        results.push(scoreFixtureRun({
          fixture: fixture.name,
          events: [],
          doctor: { ran: false, green: false, failingCodes: ["harness-error"], detail: message },
          finalToolState: { toolNames: [], referencedToolNames: [] },
          turnBudget: options.turnBudget,
          agentExit: { code: null, timedOut: false },
        }));
      }
    }
  } finally {
    await registry.close();
  }

  const report = buildInstallEvalReport({
    generatedAt,
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    model: options.model,
    promptSource: INSTALL_MDX_RELATIVE_PATH,
    prompt,
    fixtures: results,
  });
  const artifacts = await resolved.writeReport(report, {
    reportsDir: path.join(deps.context.corpusRoot, "reports"),
  });

  if (options.json) {
    deps.stdout(JSON.stringify(report, null, 2));
  } else {
    deps.stdout(renderInstallEvalMarkdown(report));
    deps.stdout(`Report: ${artifacts.markdown}`);
  }

  const failed = report.summary.cleanRuns < report.summary.fixtureCount;
  return options.strict && failed ? 1 : 0;
}
