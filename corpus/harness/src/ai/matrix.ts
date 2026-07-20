import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { overridesFileSchema, toolsFileSchema } from "@vendoai/actions";
import {
  applyDraft,
  claudeHarness,
  runStagedExtraction,
  type ExtractionDraft,
  type ExtractionHarness,
  type StaticTool,
} from "@vendoai/vendo/extract";
import { actualToolIdentity } from "../layers/scored.js";
import type { ScorecardCheck, ScorecardScore } from "../scorecard.js";
import { loadRepoAiExpectations, type RepoAiExpectations } from "./expectations.js";
import { scoreAiExtraction, type AiScoredStaticTool } from "./score.js";

/**
 * The AI extraction eval matrix (install-dx lane 3): repo × model → score.
 * Each cell runs the REAL extraction flow — the staged pipeline
 * (survey → draft-per-surface → cross-check → brief) over the repo's static
 * `.vendo/tools.json` through the ExtractionHarness (Claude Agent SDK, model
 * picked via VENDO_EXTRACTION_MODEL), then applyDraft's deterministic guards
 * into a clean per-model scratch root — and scores the result with the pure
 * rubric in score.ts. On-demand only: never part of `pnpm test`.
 */

/** Model label used when the harness default is exercised (no override). */
export const DEFAULT_MODEL_LABEL = "default";

export interface AiRepoStaticContext {
  forPipeline: StaticTool[];
  forScoring: AiScoredStaticTool[];
  appName: string;
}

export interface AiModelRunResult {
  model: string;
  /** A run that produced no scoreable draft records why here. */
  failure?: string;
  /** Honest degradation notes from the staged pipeline (skipped surfaces,
   * failed cross-check, …). */
  notes: string[];
  score: ScorecardScore;
  dimensions: Record<string, ScorecardScore>;
  checks: ScorecardCheck[];
  hardFailure: boolean;
  artifactsDir: string;
}

export interface AiRepoResult {
  repo: string;
  /** Repo-level preparation failure (checkout/bootstrap/init); no model runs. */
  failure?: string;
  labeled: boolean;
  models: AiModelRunResult[];
}

export interface AiScoreboardDocument {
  version: 1;
  generatedAt: string;
  models: string[];
  summary: {
    repoCount: number;
    runCount: number;
    scoredRuns: number;
    failedRuns: number;
  };
  repos: AiRepoResult[];
}

/** Read the repo's static extraction output and shape it for the pipeline
 * and the scorer. Throws when `.vendo/tools.json` is missing or invalid —
 * the repo must have gone through `vendo init` first. */
export async function readRepoStaticContext(appRoot: string): Promise<AiRepoStaticContext> {
  const raw = await readFile(path.join(appRoot, ".vendo", "tools.json"), "utf8");
  const parsed = toolsFileSchema.parse(JSON.parse(raw));

  const forPipeline: StaticTool[] = [];
  const forScoring: AiScoredStaticTool[] = [];
  for (const tool of parsed.tools) {
    const binding = tool.binding as { method?: string; path?: string };
    forPipeline.push({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      ...(tool.disabled === undefined ? {} : { disabled: tool.disabled }),
      ...(typeof binding.method === "string" ? { method: binding.method } : {}),
      ...(typeof binding.path === "string" ? { path: binding.path } : {}),
    });
    forScoring.push({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      ...(tool.critical === undefined ? {} : { critical: tool.critical }),
      ...(tool.disabled === undefined ? {} : { disabled: tool.disabled }),
      identity: actualToolIdentity(tool),
    });
  }

  let appName = "app";
  try {
    const packageJson = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")) as { name?: unknown };
    if (typeof packageJson.name === "string" && packageJson.name.length > 0) appName = packageJson.name;
  } catch {
    // package.json is optional context
  }
  return { forPipeline, forScoring, appName };
}

export function modelDirName(model: string): string {
  const slug = model.toLowerCase().replaceAll(/[^a-z0-9.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "model";
}

export interface EvaluateDraftOptions {
  /** null = the staged pipeline produced nothing usable. */
  draft: ExtractionDraft | null;
  draftError?: string;
  statics: AiRepoStaticContext;
  expected: RepoAiExpectations | null;
  /** Clean directory applyDraft treats as the app root; its `.vendo/`
   * overrides.json + brief.md become run artifacts. */
  scratchRoot: string;
}

/** Deterministic tail of one matrix cell: guard-apply + score. Also the
 * canned-draft test seam — no model involved. */
export async function evaluateDraft(options: EvaluateDraftOptions): Promise<ReturnType<typeof scoreAiExtraction>> {
  if (options.draft === null) {
    return scoreAiExtraction({
      staticTools: options.statics.forScoring,
      draft: null,
      draftError: options.draftError ?? "staged extraction produced no draft",
      overrides: {},
      expected: options.expected,
    });
  }

  await applyDraft({ root: options.scratchRoot, draft: options.draft, tools: options.statics.forPipeline });
  const overridesRaw = await readFile(path.join(options.scratchRoot, ".vendo", "overrides.json"), "utf8");
  const overrides = overridesFileSchema.parse(JSON.parse(overridesRaw)).tools;

  return scoreAiExtraction({
    staticTools: options.statics.forScoring,
    draft: options.draft,
    overrides,
    expected: options.expected,
  });
}

export interface RunAiRepoMatrixOptions {
  repoName: string;
  appRoot: string;
  expectationsRoot: string;
  models: readonly string[];
  aiLogsDir: string;
  env: Record<string, string | undefined>;
  harness: ExtractionHarness;
  onProgress?: (line: string) => void;
}

/** Structural copy of the claude-harness SDK seam type (it is not exported). */
interface LoadedSdk {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>;
}

/**
 * The Claude Agent SDK deliberately exists NOWHERE in the workspace: the
 * host-only resolution doctrine is that the SDK resolves
 * from a HOST app only — and pnpm's hidden hoist plus NODE_PATH would make a
 * workspace copy resolvable from anywhere under test runners. The matrix
 * therefore provisions its own pinned copy into a gitignored cache under
 * `corpus/.repos/` on first use.
 */
export const AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
/** Pinned ≥7 days behind latest so machines with a release-age
 * (`before`/minimumReleaseAge) supply-chain policy can install it. */
export const AGENT_SDK_VERSION = "0.3.207";

export function agentSdkDir(reposDir: string): string {
  return path.join(reposDir, ".agent-sdk");
}

function resolveAgentSdk(sdkDir: string): string | null {
  try {
    return createRequire(path.join(sdkDir, "package.json")).resolve(AGENT_SDK_PACKAGE);
  } catch {
    return null;
  }
}

function npmInstallAgentSdk(sdkDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--no-audit", "--no-fund", `${AGENT_SDK_PACKAGE}@${AGENT_SDK_VERSION}`], {
      cwd: sdkDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install exited ${code ?? "by signal"}${stderr ? `:\n${stderr.trim()}` : ""}`));
    });
  });
}

/** Provision the pinned SDK into the cache (network on first run only).
 * Throws with a clear message when it cannot; never hangs waiting for input. */
export async function ensureAgentSdk(
  sdkDir: string,
  install: (dir: string) => Promise<void> = npmInstallAgentSdk,
): Promise<void> {
  if (resolveAgentSdk(sdkDir) !== null) return;
  await mkdir(sdkDir, { recursive: true });
  await writeFile(
    path.join(sdkDir, "package.json"),
    `${JSON.stringify({ name: "vendo-corpus-agent-sdk-cache", private: true }, null, 2)}\n`,
  );
  try {
    await install(sdkDir);
  } catch (error) {
    throw new Error(
      `Could not provision ${AGENT_SDK_PACKAGE}@${AGENT_SDK_VERSION} into ${sdkDir} `
        + `(${error instanceof Error ? error.message : String(error)}). `
        + "The AI matrix installs the SDK there on first run and needs npm + network access.",
    );
  }
  if (resolveAgentSdk(sdkDir) === null) {
    throw new Error(`${AGENT_SDK_PACKAGE} still does not resolve from ${sdkDir} after install.`);
  }
}

async function loadSdkFromCache(sdkDir: string): Promise<LoadedSdk | null> {
  const resolved = resolveAgentSdk(sdkDir);
  if (resolved === null) return null;
  return await import(pathToFileURL(resolved).href) as unknown as LoadedSdk;
}

export function corpusExtractionHarness(sdkDir: string): ExtractionHarness {
  return claudeHarness({ loadSdk: () => loadSdkFromCache(sdkDir) });
}

/** Run every requested model over one prepared (init-complete) repo. */
export async function runAiRepoMatrix(options: RunAiRepoMatrixOptions): Promise<AiRepoResult> {
  const harness = options.harness;
  const statics = await readRepoStaticContext(options.appRoot);
  const expected = await loadRepoAiExpectations(options.expectationsRoot, options.repoName);
  await mkdir(options.aiLogsDir, { recursive: true });

  const models: AiModelRunResult[] = [];
  const takenDirNames = new Set<string>();
  for (const model of options.models) {
    // Distinct model ids may normalize to the same slug — keep artifact
    // directories unique within the run.
    let dirName = modelDirName(model);
    for (let suffix = 2; takenDirNames.has(dirName); suffix += 1) dirName = `${modelDirName(model)}-${suffix}`;
    takenDirNames.add(dirName);
    const artifactsDir = path.join(options.aiLogsDir, dirName);
    await rm(artifactsDir, { recursive: true, force: true });
    await mkdir(artifactsDir, { recursive: true });
    const env = model === DEFAULT_MODEL_LABEL
      ? { ...options.env }
      : { ...options.env, VENDO_EXTRACTION_MODEL: model };

    let draft: ExtractionDraft | null = null;
    let failure: string | undefined;
    let notes: string[] = [];
    try {
      options.onProgress?.(`${options.repoName} × ${model}: staged extraction over the codebase…`);
      const staged = await runStagedExtraction({
        root: options.appRoot,
        env,
        harness,
        tools: statics.forPipeline,
        appName: statics.appName,
        onProgress: (line) => options.onProgress?.(`  ${line}`),
      });
      draft = staged.draft;
      notes = staged.notes;
    } catch (error) {
      failure = `staged extraction failed: ${error instanceof Error ? error.message : String(error)}`;
      await writeFile(path.join(artifactsDir, "error.txt"), `${failure}\n`);
    }

    // Preserve the per-stage artifacts the pipeline wrote into the repo's
    // `.vendo/data/extract/` — the next model's run clears that directory.
    // A run that died before its first stage has no directory to copy.
    const stageDir = path.join(options.appRoot, ".vendo", "data", "extract");
    try {
      await cp(stageDir, path.join(artifactsDir, "stages"), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (notes.length > 0) {
      await writeFile(path.join(artifactsDir, "notes.txt"), `${notes.join("\n")}\n`);
    }

    // The deterministic tail can fail too (guard-apply IO, malformed
    // overrides); that floors THIS cell, never the sibling models or the
    // whole repo row (Devin finding on #372).
    let score: Awaited<ReturnType<typeof evaluateDraft>>;
    try {
      score = await evaluateDraft({
        draft,
        ...(failure === undefined ? {} : { draftError: failure }),
        statics,
        expected,
        scratchRoot: artifactsDir,
      });
    } catch (error) {
      failure = `draft evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
      await writeFile(path.join(artifactsDir, "error.txt"), `${failure}\n`);
      score = await evaluateDraft({
        draft: null,
        draftError: failure,
        statics,
        expected,
        scratchRoot: artifactsDir,
      });
    }
    await writeFile(
      path.join(artifactsDir, "checks.json"),
      `${JSON.stringify({ score: score.score, dimensions: score.dimensions, checks: score.checks, notes }, null, 2)}\n`,
    );
    models.push({
      model,
      ...(failure === undefined ? {} : { failure }),
      notes,
      score: score.score,
      dimensions: score.dimensions,
      checks: score.checks,
      hardFailure: score.hardFailure,
      artifactsDir,
    });
  }

  return { repo: options.repoName, labeled: expected !== null, models };
}

export function buildAiScoreboard(input: {
  generatedAt: string;
  models: readonly string[];
  repos: readonly AiRepoResult[];
}): AiScoreboardDocument {
  const runs = input.repos.flatMap((repo) => repo.models);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    models: [...input.models],
    summary: {
      repoCount: input.repos.length,
      runCount: runs.length,
      scoredRuns: runs.filter((run) => !run.hardFailure).length,
      failedRuns: runs.filter((run) => run.hardFailure).length + input.repos.filter((repo) => repo.failure).length,
    },
    repos: [...input.repos],
  };
}

const DIMENSION_COLUMNS = ["draft", "guards", "descriptions", "risk", "wake", "brief"] as const;

function cell(score: ScorecardScore | undefined): string {
  if (!score || score.total === 0) return "—";
  return `${score.passed}/${score.total}`;
}

/** Raw error messages and notes go into table cells — keep them from
 * breaking the row. */
function escapeCell(text: string): string {
  return text.replaceAll(/\r?\n/g, " ").replaceAll("|", "\\|");
}

export function renderAiScoreboardMarkdown(doc: AiScoreboardDocument): string {
  const lines = [
    "# AI extraction scoreboard",
    "",
    `Generated: ${doc.generatedAt}`,
    `Models: ${doc.models.join(", ")}`,
    "",
    `Summary: ${doc.summary.scoredRuns}/${doc.summary.runCount} runs scored; ${doc.summary.failedRuns} failures.`,
    "",
    `| Repo | Model | Score | ${DIMENSION_COLUMNS.map((name) => name[0]?.toUpperCase() + name.slice(1)).join(" | ")} | Notes |`,
    `| --- | --- | --- | ${DIMENSION_COLUMNS.map(() => "---").join(" | ")} | --- |`,
  ];

  for (const repo of doc.repos) {
    if (repo.failure) {
      lines.push(`| ${repo.repo} | — | FAIL | ${DIMENSION_COLUMNS.map(() => "—").join(" | ")} | ${escapeCell(repo.failure)} |`);
      continue;
    }
    for (const run of repo.models) {
      const notes = [
        ...(run.failure ? [run.failure] : []),
        ...(repo.labeled ? [] : ["no ai-expected.json labels"]),
        ...(run.notes.length > 0 ? [`${run.notes.length} degradation note${run.notes.length === 1 ? "" : "s"}`] : []),
        ...run.checks.filter((check) => !check.pass).map((check) => check.id),
      ];
      lines.push([
        "",
        repo.repo,
        run.model,
        `${run.score.value.toFixed(3)} (${cell(run.score)})`,
        ...DIMENSION_COLUMNS.map((name) => cell(run.dimensions[name])),
        escapeCell(notes.join("; ")) || "all checks passed",
        "",
      ].join(" | ").trim());
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function writeAiScoreboardArtifacts(
  doc: AiScoreboardDocument,
  options: { logsRoot: string },
): Promise<{ json: string; markdown: string }> {
  const json = path.join(options.logsRoot, "ai-scoreboard.json");
  const markdown = path.join(options.logsRoot, "ai-scoreboard.md");
  await mkdir(options.logsRoot, { recursive: true });
  await writeFile(json, `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(markdown, renderAiScoreboardMarkdown(doc));
  return { json, markdown };
}
