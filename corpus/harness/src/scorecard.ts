import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CorpusRunContext } from "./run-context.js";

export type ScorecardLayerStatus = "pass" | "fail" | "skip";

export interface ScorecardCheck {
  id: string;
  pass: boolean;
  status?: string;
  detail: string;
}

export interface ScorecardScore {
  passed: number;
  total: number;
  value: number;
}

export interface ScorecardLayerInput {
  layer: number;
  name: string;
  status?: ScorecardLayerStatus;
  score?: ScorecardScore;
  checks?: readonly ScorecardCheck[];
  detail?: string;
  logPaths?: readonly string[];
  hardFailure?: boolean;
}

export interface ScorecardRepoInput {
  repo: string;
  layers: readonly ScorecardLayerInput[];
}

export interface BuildScorecardInput {
  generatedAt?: string;
  strict: boolean;
  repos: readonly ScorecardRepoInput[];
}

export interface ScorecardLayer {
  layer: number;
  name: string;
  status: ScorecardLayerStatus;
  score?: ScorecardScore;
  checks: ScorecardCheck[];
  detail?: string;
  logPaths: string[];
  hardFailure: boolean;
}

export interface ScorecardRepo {
  repo: string;
  layers: ScorecardLayer[];
}

export interface ScorecardSummary {
  repoCount: number;
  layerCount: number;
  passedLayers: number;
  failedLayers: number;
  hardFailureCount: number;
}

export interface ScorecardDocument {
  version: 1;
  generatedAt: string;
  strict: boolean;
  summary: ScorecardSummary;
  repos: ScorecardRepo[];
}

export interface RenderScorecardMarkdownOptions {
  linkBaseDir?: string;
}

export interface WriteScorecardArtifactsOptions {
  context: CorpusRunContext;
}

export interface ScorecardArtifactPaths {
  json: string;
  markdown: string;
}

export interface WrittenScorecardArtifacts extends ScorecardArtifactPaths {
  perRepo: Record<string, ScorecardArtifactPaths>;
}

function scoreFromChecks(checks: readonly ScorecardCheck[]): ScorecardScore {
  const passed = checks.filter((check) => check.pass).length;
  const total = checks.length;
  return {
    passed,
    total,
    value: total === 0 ? 0 : passed / total,
  };
}

function normalizeLayer(input: ScorecardLayerInput): ScorecardLayer {
  const checks = [...(input.checks ?? [])];
  const score = input.score ?? (checks.length > 0 ? scoreFromChecks(checks) : undefined);
  const status = input.status ?? (checks.every((check) => check.pass) ? "pass" : "fail");
  const hardFailure = input.hardFailure ?? status === "fail";

  return {
    layer: input.layer,
    name: input.name,
    status,
    score,
    checks,
    detail: input.detail,
    logPaths: [...(input.logPaths ?? [])],
    hardFailure,
  };
}

export function buildScorecard(input: BuildScorecardInput): ScorecardDocument {
  const repos = input.repos.map((repo) => ({
    repo: repo.repo,
    layers: repo.layers.map(normalizeLayer),
  }));
  const layers = repos.flatMap((repo) => repo.layers);

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    strict: input.strict,
    summary: {
      repoCount: repos.length,
      layerCount: layers.length,
      passedLayers: layers.filter((layer) => layer.status === "pass").length,
      failedLayers: layers.filter((layer) => layer.status === "fail").length,
      hardFailureCount: layers.filter((layer) => layer.hardFailure).length,
    },
    repos,
  };
}

export function scorecardExitCode(scorecard: ScorecardDocument): number {
  return scorecard.strict && scorecard.summary.hardFailureCount > 0 ? 1 : 0;
}

function normalizePathForMarkdown(filePath: string, linkBaseDir?: string): string {
  const relative = linkBaseDir && path.isAbsolute(filePath)
    ? path.relative(linkBaseDir, filePath)
    : filePath;
  return relative.split(path.sep).join("/");
}

function markdownLink(filePath: string, linkBaseDir?: string): string {
  const href = normalizePathForMarkdown(filePath, linkBaseDir);
  return `[${href}](${href})`;
}

function scoreLabel(score: ScorecardScore | undefined): string {
  if (!score) return "";
  return `${score.passed}/${score.total}`;
}

function statusLabel(status: ScorecardLayerStatus): string {
  return status.toUpperCase();
}

export function renderScorecardMarkdown(
  scorecard: ScorecardDocument,
  options: RenderScorecardMarkdownOptions = {},
): string {
  const lines = [
    "# Corpus scorecard",
    "",
    `Generated: ${scorecard.generatedAt}`,
    "",
    `Summary: ${scorecard.summary.passedLayers}/${scorecard.summary.layerCount} layers passing; ${scorecard.summary.hardFailureCount} hard failures.`,
    "",
    "| Repo | Layer | Status | Score | Logs |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const repo of scorecard.repos) {
    for (const layer of repo.layers) {
      const logs = layer.logPaths.map((logPath) => markdownLink(logPath, options.linkBaseDir)).join(", ");
      lines.push([
        repo.repo,
        `Layer ${layer.layer} ${layer.name}`,
        statusLabel(layer.status),
        scoreLabel(layer.score),
        logs,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function writeScorecardArtifacts(
  scorecard: ScorecardDocument,
  options: WriteScorecardArtifactsOptions,
): Promise<WrittenScorecardArtifacts> {
  const logsRoot = path.join(options.context.reposDir, ".logs");
  const json = path.join(logsRoot, "scorecard.json");
  const markdown = path.join(logsRoot, "scorecard.md");
  const jsonSource = `${JSON.stringify(scorecard, null, 2)}\n`;
  const markdownSource = renderScorecardMarkdown(scorecard, { linkBaseDir: options.context.corpusRoot });
  const perRepo: Record<string, ScorecardArtifactPaths> = {};

  await mkdir(logsRoot, { recursive: true });
  await writeFile(json, jsonSource);
  await writeFile(markdown, markdownSource);

  for (const repo of scorecard.repos) {
    const runDir = path.join(options.context.repoDir(repo.repo), "run");
    const repoJson = path.join(runDir, "scorecard.json");
    const repoMarkdown = path.join(runDir, "scorecard.md");
    await mkdir(runDir, { recursive: true });
    await writeFile(repoJson, jsonSource);
    await writeFile(repoMarkdown, markdownSource);
    perRepo[repo.repo] = { json: repoJson, markdown: repoMarkdown };
  }

  return { json, markdown, perRepo };
}
