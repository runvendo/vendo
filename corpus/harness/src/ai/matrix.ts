import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toolsFileSchema } from "@vendoai/actions";
import {
  claudeHarness,
  runJudgmentPass as defaultRunJudgmentPass,
  type ExtractionHarness,
  type JudgmentPassCounts,
  type JudgmentPassOptions,
  type JudgmentPassResult,
} from "@vendoai/vendo/extract";
import { actualToolIdentity } from "../layers/scored.js";
import type { ScorecardCheck, ScorecardScore } from "../scorecard.js";
import { loadRepoAiExpectations, type RepoAiExpectations } from "./expectations.js";
import {
  aiScoredJudgmentsFileSchema,
  scoreAiJudgments,
  type AiScoredJudgment,
  type AiScoredStaticTool,
} from "./score.js";

/**
 * The judgment-channel eval matrix: repo × model → score. On-demand only, never
 * part of `pnpm test`.
 *
 * One cell = one real `runJudgmentPass` over a prepared (init-complete) repo,
 * graded against `corpus/expectations/<repo>/ai-expected.json`. Three choices
 * carry the whole design:
 *
 * - the pass reads the REAL repo (`root`) so the judge and the skeptic open real
 *   handlers, but writes to a per-cell SCRATCH `.vendo` (`out`). The repo's own
 *   judgments are never clobbered, and two models in the same run cannot see
 *   each other's answers;
 * - `loosenings: "review"` with an always-yes `confirm`. A loosening — a risk
 *   downgrade, a woken tool — is exactly the thing the channel refuses to apply
 *   on its own, and an unattended `confirm` DECLINES by default. Without the
 *   auto-approval every downgrade the labels ask for would be dropped and the
 *   matrix would only ever measure hardenings;
 * - a cell is scored from the judgments file READ BACK OFF DISK, not from the
 *   pass's return value. That is the artifact the runtime will actually merge, so
 *   it is the only honest thing to grade.
 *
 * A failure — unreachable model, keyless engine, malformed artifact — floors THAT
 * cell and never the sibling models or the repo row.
 */

/** Model label used when the harness default is exercised (no override). */
export const DEFAULT_MODEL_LABEL = "default";

export interface AiRepoStaticContext {
  forScoring: AiScoredStaticTool[];
  appName: string;
}

export interface AiModelRunResult {
  model: string;
  /** A cell that produced nothing scoreable records why here. */
  failure?: string;
  /** Honest degradation notes from the pass (queued loosenings, skeptic
   * rejections, evidenceless proposals). */
  notes: string[];
  /** The pass's own tallies, when it got far enough to report them. */
  counts?: JudgmentPassCounts;
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

/** Read the repo's static extraction output and shape it for the scorer. Throws
 * when `.vendo/tools.json` is missing or invalid — the repo must have gone
 * through `vendo init` first. */
export async function readRepoStaticContext(appRoot: string): Promise<AiRepoStaticContext> {
  const raw = await readFile(path.join(appRoot, ".vendo", "tools.json"), "utf8");
  const parsed = toolsFileSchema.parse(JSON.parse(raw) as unknown);

  // The WHOLE tool, not a reduction: `applyJudgment` needs a real ExtractedTool
  // to run the binding check and the fail-closed audience rule.
  const forScoring: AiScoredStaticTool[] = parsed.tools.map((tool) => ({
    tool,
    identity: actualToolIdentity(tool),
  }));

  let appName = "app";
  try {
    const packageJson = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")) as { name?: unknown };
    if (typeof packageJson.name === "string" && packageJson.name.length > 0) appName = packageJson.name;
  } catch {
    // package.json is optional context
  }
  return { forScoring, appName };
}

export function modelDirName(model: string): string {
  const slug = model.toLowerCase().replaceAll(/[^a-z0-9.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "model";
}

/** The judgment pass, injectable so harness tests can drive every branch without
 *  a model (`pnpm test` never calls one). */
export type JudgmentPassRunner = (options: JudgmentPassOptions) => Promise<JudgmentPassResult>;

/** Seed a per-cell scratch `.vendo` from the repo's real one. `tools.json` is
 *  required (the pass answers `skipped` without it); `overrides.json` is copied
 *  when present because the judge reads it as prompt context. */
async function seedScratchVendo(appRoot: string, scratchVendo: string): Promise<void> {
  await mkdir(scratchVendo, { recursive: true });
  await copyFile(path.join(appRoot, ".vendo", "tools.json"), path.join(scratchVendo, "tools.json"));
  try {
    await copyFile(path.join(appRoot, ".vendo", "overrides.json"), path.join(scratchVendo, "overrides.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Read back what the pass wrote. `null` = nothing to grade. A malformed file
 *  THROWS, naming the artifact: the corpus must not quietly score a broken
 *  artifact as an empty one, and the blame belongs on the file rather than on the
 *  model call that finished fine. */
async function readScratchJudgments(
  scratchVendo: string,
): Promise<Readonly<Record<string, AiScoredJudgment>> | null> {
  const file = path.join(scratchVendo, "judgments.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return aiScoredJudgmentsFileSchema.parse(JSON.parse(raw) as unknown).tools;
  } catch (error) {
    throw new Error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Why a non-`judged` status produced nothing to score, in the pass's own terms. */
function statusFailure(result: JudgmentPassResult): string | undefined {
  if (result.status === "judged") return undefined;
  if (result.status === "structural-only") {
    return `the judgment pass returned structural-only (${result.unjudged} tools unjudged)`
      + " — the matrix needs a real model credential";
  }
  if (result.status === "up-to-date") {
    return "the judgment pass returned up-to-date — the scratch root had nothing to judge";
  }
  return "the judgment pass returned skipped — no usable model output, or no tools.json";
}

/** The pass's tallies, as the degradation notes a scoreboard row carries. */
function degradationNotes(counts: JudgmentPassCounts): string[] {
  const notes: string[] = [];
  if (counts.queued > 0) notes.push(`${counts.queued} loosenings queued rather than approved`);
  if (counts.rejectedBySkeptic > 0) notes.push(`${counts.rejectedBySkeptic} rejected by the skeptic`);
  if (counts.unexaminedRejected > 0) {
    notes.push(`${counts.unexaminedRejected} unexamined after one re-ask, rejected`);
  }
  if (counts.evidenceless > 0) notes.push(`${counts.evidenceless} proposals carried no evidence`);
  return notes;
}

/**
 * The pass's warnings, lifted off its output channel.
 *
 * `JudgmentPassResult` does not carry them, and they are the single biggest
 * confounder for this scoreboard: an unusable judge batch takes EVERY proposal in
 * it down, so coverage and risk accuracy drop for a reason that is not model
 * quality. Without this the table would show the depressed number and no cause.
 *
 * Coverage leads ("missed surface") are excluded — those are findings ABOUT the
 * repo, not degradations of the run.
 *
 * Each note is collapsed to one line and clipped: the real batch-parse warning
 * embeds a whole zod issue array, and ~300 characters of JSON punctuation in a
 * table cell hides the very fact it is there to report. The untruncated text is
 * always in the cell's `pass.log`.
 */
const NOTE_MAX = 160;

function warningNotes(transcript: readonly string[]): string[] {
  return transcript
    .filter((line) => line.startsWith("stderr: warning:") && !line.includes("missed surface"))
    .map((line) => {
      const flat = line.replace(/^stderr: warning:\s*/, "").replaceAll(/\s+/g, " ").trim();
      return flat.length <= NOTE_MAX ? flat : `${flat.slice(0, NOTE_MAX - 1)}…`;
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
  /** Test seam. Defaults to the real `runJudgmentPass`. */
  runPass?: JudgmentPassRunner;
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
    const resolved = createRequire(path.join(sdkDir, "package.json")).resolve(AGENT_SDK_PACKAGE);
    // Node's resolver also walks NODE_PATH / GLOBAL_FOLDERS (Vitest injects
    // pnpm's flat virtual-store `node_modules` there), which would make any
    // copy of the SDK hoisted anywhere in the workspace resolve here too —
    // exactly the ambient-resolution hazard called out above. Only accept a
    // resolution that actually lives under the cache dir this function
    // provisions; anything else is not "resolvable from the cache", so
    // report it as absent and let ensureAgentSdk provision its own copy.
    // Compare real paths — `resolved` is symlink-resolved by Node, so a
    // sdkDir that is itself reached through a symlink (e.g. macOS's
    // /var -> /private/var) must be realpath'd too before the containment
    // check, or a genuine in-cache resolution looks like it escaped sdkDir.
    const realSdkDir = realpathSync(sdkDir);
    const relativeToSdkDir = path.relative(realSdkDir, resolved);
    if (relativeToSdkDir.startsWith("..") || path.isAbsolute(relativeToSdkDir)) return null;
    return resolved;
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
  const runPass = options.runPass ?? defaultRunJudgmentPass;
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
    const scratchVendo = path.join(artifactsDir, "scratch", ".vendo");

    const env = model === DEFAULT_MODEL_LABEL
      ? { ...options.env }
      : { ...options.env, VENDO_MODEL_EXTRACT: model };

    // The pass's narrative IS the evidence a human reads to believe a cell, so it
    // is captured per cell rather than interleaved across models on stdout.
    const transcript: string[] = [];
    const output = {
      log: (message: string) => { transcript.push(message); },
      error: (message: string) => { transcript.push(`stderr: ${message}`); },
    };

    let judgments: Readonly<Record<string, AiScoredJudgment>> | null = null;
    let failure: string | undefined;
    let counts: JudgmentPassCounts | undefined;
    let notes: string[] = [];

    options.onProgress?.(`${options.repoName} × ${model}: judging`);
    try {
      await seedScratchVendo(options.appRoot, scratchVendo);
      const result = await runPass({
        root: options.appRoot,
        out: scratchVendo,
        mode: "full",
        loosenings: "review",
        // Headless approval. The review gate exists for a human; a matrix cell has
        // none, and DECLINING would silently drop every downgrade the labels ask
        // for — so the auto-yes is what makes the downgrade path measurable.
        confirm: async () => true,
        env,
        output,
        harness: options.harness,
        appName: statics.appName,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      failure = statusFailure(result);
      if (result.status === "judged") {
        counts = result;
        notes = degradationNotes(result);
      }
      notes = [...notes, ...warningNotes(transcript)];
    } catch (error) {
      failure = `judgment pass failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Read back separately from the call above, so a broken artifact is never
    // reported as a failed model call. Both float THIS cell only.
    try {
      judgments = await readScratchJudgments(scratchVendo);
      if (judgments === null && failure === undefined) {
        failure = "the judgment pass reported success but wrote no judgments.json";
      }
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
      judgments = null;
    }

    if (transcript.length > 0) {
      await writeFile(path.join(artifactsDir, "pass.log"), `${transcript.join("\n")}\n`);
    }
    if (failure !== undefined) await writeFile(path.join(artifactsDir, "error.txt"), `${failure}\n`);
    if (notes.length > 0) await writeFile(path.join(artifactsDir, "notes.txt"), `${notes.join("\n")}\n`);

    const score = scoreAiJudgments({
      staticTools: statics.forScoring,
      judgments: failure === undefined ? judgments : null,
      ...(failure === undefined ? {} : { passError: failure }),
      expected,
    });
    await writeFile(
      path.join(artifactsDir, "checks.json"),
      `${JSON.stringify({ score: score.score, dimensions: score.dimensions, checks: score.checks, notes, counts }, null, 2)}\n`,
    );
    models.push({
      model,
      ...(failure === undefined ? {} : { failure }),
      notes,
      ...(counts === undefined ? {} : { counts }),
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

/** The scoreboard's judgment dimensions, in the order a reader wants them:
 *  label accuracy first, then the channel's own integrity, then prose. */
const DIMENSION_COLUMNS = [
  { key: "risk", header: "Risk accuracy" },
  { key: "confirmEach", header: "Confirm each" },
  { key: "wake", header: "Wake" },
  { key: "evidence", header: "Evidence" },
  { key: "descriptions", header: "Descriptions" },
] as const;

/** A dimension cell. Percentages, not raw point sums: a fractional check score
 *  renders as `0.333333/1`, which is unreadable in a table a human scans. The
 *  real x-of-y counts live in each check's detail, reproduced under the table. */
function cell(score: ScorecardScore | undefined): string {
  if (!score || score.total === 0) return "—";
  return `${Math.round(score.value * 100)}%`;
}

function overallCell(score: ScorecardScore): string {
  return `${score.value.toFixed(3)} (${Number(score.passed.toFixed(2))}/${score.total})`;
}

/** Raw error messages and notes go into table cells — keep them from
 * breaking the row. */
function escapeCell(text: string): string {
  return text.replaceAll(/\r?\n/g, " ").replaceAll("|", "\\|");
}

export function renderAiScoreboardMarkdown(doc: AiScoreboardDocument): string {
  const lines = [
    "# Judgment channel scoreboard",
    "",
    `Generated: ${doc.generatedAt}`,
    `Models: ${doc.models.join(", ")}`,
    "",
    `Summary: ${doc.summary.scoredRuns}/${doc.summary.runCount} runs scored; ${doc.summary.failedRuns} failures.`,
    "",
    `| Repo | Model | Overall | ${DIMENSION_COLUMNS.map((column) => column.header).join(" | ")} | Notes |`,
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
        ...run.notes,
        ...run.checks.filter((check) => !check.pass).map((check) => check.id),
      ];
      lines.push([
        "",
        repo.repo,
        run.model,
        overallCell(run.score),
        ...DIMENSION_COLUMNS.map((column) => cell(run.dimensions[column.key])),
        escapeCell(notes.join("; ")) || "all checks passed",
        "",
      ].join(" | ").trim());
    }
  }

  // The percentages above are scannable but lossy — "33%" does not say 1-of-3.
  // Every failing check's own detail carries the counts, so it is reproduced
  // verbatim here rather than left in a per-cell checks.json nobody opens.
  const failing = doc.repos.flatMap((repo) =>
    repo.models.flatMap((run) =>
      run.checks.filter((check) => !check.pass).map((check) => ({ repo: repo.repo, run, check }))));
  if (failing.length > 0) {
    lines.push("", "## Failing checks", "");
    let heading = "";
    for (const { repo, run, check } of failing) {
      const current = `${repo} × ${run.model}`;
      if (current !== heading) {
        heading = current;
        lines.push(`### ${current}`, "");
      }
      lines.push(`- \`${check.id}\` — ${escapeCell(check.detail)}`);
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

export type { RepoAiExpectations };
