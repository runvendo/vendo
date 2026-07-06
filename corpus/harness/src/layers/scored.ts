import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  manifestThemeSchema,
  toolsManifestSchema,
  type ManifestTheme,
  type ManifestTool,
} from "@vendoai/core";
import {
  THEME_RUBRIC_DIMENSIONS,
  loadRepoBaseline,
  loadRepoExpectations,
  repoBaselinePath,
  type ExpectedComponentAnnotation,
  type ExpectedToolAnnotation,
  type ExpectedToolInventory,
  type RepoBaseline,
  type RepoExpectations,
  type ThemeRubricDimension,
} from "../expectations.js";
import type { ScorecardCheck, ScorecardLayerInput, ScorecardScore } from "../scorecard.js";

export interface ScoredLayerContext {
  repoName: string;
  repoDir: string;
  expectationsRoot: string;
  now?: () => Date;
}

export interface ScoredBaselineUpdate {
  path: string;
  source: string;
}

export interface ScoredLayerRunResult {
  layer: ScorecardLayerInput;
  baselineUpdate?: ScoredBaselineUpdate;
}

interface ActualComponent {
  name: string;
  description: string;
  props: string[];
}

interface WeightedResult {
  checks: ScorecardCheck[];
  points: number;
  total: number;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DESTRUCTIVE_NAME = /(^|_)(delete|remove|destroy|cancel|close|reset|revoke|purge|wipe)(_|$)/;
const EPSILON = 0.000001;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function score(points: number, total: number): ScorecardScore {
  return {
    passed: round(points),
    total,
    value: total === 0 ? 0 : round(points / total),
  };
}

function normalizeThemeValue(dimension: ThemeRubricDimension, value: RepoExpectations["theme"][ThemeRubricDimension] | ManifestTheme[ThemeRubricDimension]): string {
  if (dimension === "radius") {
    return typeof value === "number" ? `${value}px` : value.toLowerCase();
  }
  return String(value).trim().toLowerCase();
}

function scoreTheme(expected: RepoExpectations, actual: ManifestTheme): WeightedResult {
  let points = 0;
  const checks = THEME_RUBRIC_DIMENSIONS.map((dimension) => {
    const expectedValue = normalizeThemeValue(dimension, expected.theme[dimension]);
    const actualValue = normalizeThemeValue(dimension, actual[dimension]);
    const pass = expectedValue === actualValue;
    if (pass) points += 1;
    return {
      id: `theme.${dimension}`,
      pass,
      detail: pass
        ? `${dimension} matched ${actualValue}`
        : `${dimension} expected ${expectedValue}, got ${actualValue}`,
    };
  });

  return { checks, points, total: THEME_RUBRIC_DIMENSIONS.length };
}

function actualInventory(tool: ManifestTool): ExpectedToolInventory {
  return {
    name: tool.name,
    method: tool.binding.method,
    path: tool.binding.path,
    readOrWrite: tool.annotations.mutating ? "write" : "read",
  };
}

function inventoryKey(item: ExpectedToolInventory): string {
  return `${item.name}\t${item.method}\t${item.path}\t${item.readOrWrite}`;
}

function scoreTools(expected: RepoExpectations, actualTools: readonly ManifestTool[]): WeightedResult {
  const expectedKeys = new Set(expected.tools.map(inventoryKey));
  const actualInventories = actualTools.map(actualInventory);
  const actualKeys = actualInventories.map(inventoryKey);
  const actualMatches = actualKeys.filter((key) => expectedKeys.has(key)).length;
  const expectedMatches = expected.tools.filter((tool) => actualKeys.includes(inventoryKey(tool))).length;
  const precision = actualInventories.length === 0 ? 1 : actualMatches / actualInventories.length;
  const recall = expected.tools.length === 0 ? 1 : expectedMatches / expected.tools.length;

  return {
    points: precision + recall,
    total: 2,
    checks: [
      {
        id: "tools.precision",
        pass: precision === 1,
        detail: `${actualMatches}/${actualInventories.length} generated tools matched expected inventory; precision ${precision.toFixed(3)}`,
      },
      {
        id: "tools.recall",
        pass: recall === 1,
        detail: `${expectedMatches}/${expected.tools.length} expected tools were generated; recall ${recall.toFixed(3)}`,
      },
    ],
  };
}

function expectedAnnotationMatches(expected: ExpectedToolAnnotation, actual: ManifestTool | undefined): boolean {
  if (!actual) return false;
  if (actual.annotations.mutating !== expected.mutating) return false;
  if (actual.annotations.dangerous !== expected.dangerous) return false;
  if (expected.idempotent !== undefined && actual.annotations.idempotent !== expected.idempotent) return false;
  return true;
}

function isUnsafeAutoAllowed(tool: ManifestTool): boolean {
  const method = tool.binding.method;
  if (WRITE_METHODS.has(method) && !tool.annotations.mutating) return true;
  if ((method === "DELETE" || DESTRUCTIVE_NAME.test(tool.name)) && !tool.annotations.dangerous) return true;
  return false;
}

function scoreAnnotations(expected: RepoExpectations, actualTools: readonly ManifestTool[]): WeightedResult {
  const byName = new Map(actualTools.map((tool) => [tool.name, tool]));
  const matched = expected.annotations.filter((annotation) => expectedAnnotationMatches(annotation, byName.get(annotation.name))).length;
  const annotationScore = expected.annotations.length === 0 ? 1 : matched / expected.annotations.length;
  const unsafe = actualTools.filter(isUnsafeAutoAllowed);

  return {
    points: annotationScore,
    total: 1,
    checks: [
      {
        id: "annotations.match",
        pass: annotationScore === 1,
        detail: `${matched}/${expected.annotations.length} expected safety annotations matched generated tools`,
      },
      {
        id: "annotations.write-safety",
        pass: unsafe.length === 0,
        detail: unsafe.length === 0
          ? `${actualTools.length} generated tools keep writes fail-closed`
          : `write-capable tools are auto-allowed: ${unsafe.map((tool) => tool.name).join(", ")}`,
      },
    ],
  };
}

function parseJsonStringLiteral(source: string, field: "name" | "description"): string | null {
  const match = source.match(new RegExp(`${field}:\\s*("(?:(?:\\\\.)|[^"\\\\])*")`));
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return null;
  }
}

function parsePropNames(source: string): string[] {
  const match = source.match(/z\.object\(\s*\{([\s\S]*?)\n\}\)/);
  const body = match?.[1] ?? "";
  return [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*z\./gm)].map((prop) => prop[1]!);
}

async function readActualComponents(repoDir: string): Promise<ActualComponent[]> {
  const componentsDir = path.join(repoDir, ".vendo/components");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(componentsDir, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const components: ActualComponent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const descriptorPath = path.join(componentsDir, entry.name, "descriptor.ts");
    let source: string;
    try {
      source = await readFile(descriptorPath, "utf8");
    } catch {
      continue;
    }
    components.push({
      name: parseJsonStringLiteral(source, "name") ?? entry.name,
      description: parseJsonStringLiteral(source, "description") ?? "",
      props: parsePropNames(source),
    });
  }
  return components;
}

function componentMatches(expected: ExpectedComponentAnnotation, actual: ActualComponent | undefined): boolean {
  if (!actual) return false;
  const description = actual.description.toLowerCase();
  if (!expected.descriptionIncludes.every((snippet) => description.includes(snippet.toLowerCase()))) return false;
  const actualProps = new Set(actual.props);
  return expected.props.every((prop) => actualProps.has(prop));
}

function scoreComponents(expected: RepoExpectations, actualComponents: readonly ActualComponent[]): WeightedResult {
  if (expected.components.length === 0) {
    return { checks: [], points: 0, total: 0 };
  }
  const byName = new Map(actualComponents.map((component) => [component.name, component]));
  const matched = expected.components.filter((component) => componentMatches(component, byName.get(component.name))).length;
  const componentScore = matched / expected.components.length;
  return {
    points: componentScore,
    total: 1,
    checks: [
      {
        id: "components.annotations",
        pass: componentScore === 1,
        detail: `${matched}/${expected.components.length} expected component descriptors matched generated annotations`,
      },
    ],
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readActualTheme(repoDir: string): Promise<ManifestTheme> {
  const parsed = manifestThemeSchema.safeParse(await readJsonFile(path.join(repoDir, ".vendo/theme.json")));
  if (!parsed.success) throw new Error(`.vendo/theme.json schema error: ${parsed.error.issues[0]?.message ?? "invalid theme"}`);
  return parsed.data;
}

async function readActualTools(repoDir: string): Promise<ManifestTool[]> {
  const parsed = toolsManifestSchema.safeParse(await readJsonFile(path.join(repoDir, ".vendo/tools.json")));
  if (!parsed.success) throw new Error(`.vendo/tools.json schema error: ${parsed.error.issues[0]?.message ?? "invalid tools"}`);
  return parsed.data.tools;
}

function combine(results: readonly WeightedResult[]): { checks: ScorecardCheck[]; score: ScorecardScore } {
  const points = results.reduce((sum, result) => sum + result.points, 0);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  return {
    checks: results.flatMap((result) => result.checks),
    score: score(points, total),
  };
}

function baselineSource(scorecardScore: ScorecardScore, now: Date): string {
  return `${JSON.stringify({
    version: 1,
    generatedAt: now.toISOString(),
    score: scorecardScore,
  }, null, 2)}\n`;
}

function baselineCheck(
  baseline: RepoBaseline | null,
  scorecardScore: ScorecardScore,
): { check: ScorecardCheck; regression: boolean; improved: boolean } {
  if (!baseline) {
    return {
      check: {
        id: "baseline.regression",
        pass: true,
        detail: "no baseline recorded; score is not regression-checked",
      },
      regression: false,
      improved: true,
    };
  }
  const current = scorecardScore.value;
  const accepted = baseline.score.value;
  if (current + EPSILON < accepted) {
    return {
      check: {
        id: "baseline.regression",
        pass: false,
        detail: `score ${current.toFixed(3)} is below baseline ${accepted.toFixed(3)}`,
      },
      regression: true,
      improved: false,
    };
  }
  return {
    check: {
      id: "baseline.regression",
      pass: true,
      detail: current > accepted + EPSILON
        ? `score ${current.toFixed(3)} is above baseline ${accepted.toFixed(3)}`
        : `score ${current.toFixed(3)} matches baseline ${accepted.toFixed(3)}`,
    },
    regression: false,
    improved: current > accepted + EPSILON,
  };
}

function inputFailure(error: unknown): ScoredLayerRunResult {
  return {
    layer: {
      layer: 2,
      name: "scored",
      status: "fail",
      checks: [{ id: "scored.inputs", pass: false, detail: errorMessage(error) }],
      detail: `Layer 2 scorer could not read generated init output: ${errorMessage(error)}`,
      hardFailure: true,
    },
  };
}

export async function runScoredLayer(ctx: ScoredLayerContext): Promise<ScoredLayerRunResult> {
  const expectations = await loadRepoExpectations(ctx.expectationsRoot, ctx.repoName);
  if (!expectations) {
    return {
      layer: {
        layer: 2,
        name: "scored",
        status: "skip",
        detail: `no expectations found at ${path.join(ctx.expectationsRoot, ctx.repoName, "expected.json")}`,
        checks: [],
        hardFailure: false,
      },
    };
  }

  let actualTheme: ManifestTheme;
  let actualTools: ManifestTool[];
  let actualComponents: ActualComponent[];
  try {
    actualTheme = await readActualTheme(ctx.repoDir);
    actualTools = await readActualTools(ctx.repoDir);
    actualComponents = await readActualComponents(ctx.repoDir);
  } catch (error) {
    return inputFailure(error);
  }

  const scored = combine([
    scoreTheme(expectations, actualTheme),
    scoreTools(expectations, actualTools),
    scoreAnnotations(expectations, actualTools),
    scoreComponents(expectations, actualComponents),
  ]);
  const baseline = await loadRepoBaseline(ctx.expectationsRoot, ctx.repoName);
  const baselineResult = baselineCheck(baseline, scored.score);
  const checks = [...scored.checks, baselineResult.check];
  const writeSafetyFailed = checks.some((check) => check.id === "annotations.write-safety" && !check.pass);
  const hardFailure = writeSafetyFailed || baselineResult.regression;
  const now = ctx.now?.() ?? new Date();
  const baselineUpdate = baselineResult.improved && !hardFailure
    ? {
        path: repoBaselinePath(ctx.expectationsRoot, ctx.repoName),
        source: baselineSource(scored.score, now),
      }
    : undefined;

  return {
    layer: {
      layer: 2,
      name: "scored",
      status: hardFailure ? "fail" : "pass",
      score: scored.score,
      checks,
      detail: [
        `score ${scored.score.value.toFixed(3)} (${scored.score.passed}/${scored.score.total})`,
        baselineResult.check.detail,
        writeSafetyFailed ? "write-safety hard check failed" : "write-safety hard check passed",
      ].join("; "),
      hardFailure,
    },
    baselineUpdate,
  };
}
