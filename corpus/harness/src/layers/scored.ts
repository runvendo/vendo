import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  vendoThemeSchema,
  type VendoTheme,
} from "@vendoai/core";
import { toolsFileSchema, type ExtractedTool } from "@vendoai/actions";
import {
  THEME_RUBRIC_DIMENSIONS,
  expectedToolIdentity,
  loadRepoBaseline,
  loadRepoExpectations,
  repoBaselinePath,
  type ExpectedComponentAnnotation,
  type ExpectedToolAnnotation,
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

function normalizeThemeValue(dimension: ThemeRubricDimension, value: RepoExpectations["theme"][ThemeRubricDimension] | string): string {
  if (dimension === "radius") {
    return typeof value === "number" ? `${value}px` : value.toLowerCase();
  }
  return String(value).trim().toLowerCase();
}

function actualThemeValue(theme: VendoTheme, dimension: ThemeRubricDimension): string {
  if (dimension === "fontFamily") return theme.typography.fontFamily;
  if (dimension === "radius") return theme.radius.medium;
  if (dimension === "mutedText") return theme.colors.muted;
  return theme.colors[dimension];
}

function scoreTheme(expected: RepoExpectations, actual: VendoTheme): WeightedResult {
  let points = 0;
  const checks = THEME_RUBRIC_DIMENSIONS.map((dimension) => {
    const expectedValue = normalizeThemeValue(dimension, expected.theme[dimension]);
    const actualValue = normalizeThemeValue(dimension, actualThemeValue(actual, dimension));
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

// A tool's IDENTITY for scoring is binding-kind-aware — the endpoint
// (method + path) for HTTP-shaped bindings, the procedure dot-path for tRPC,
// the operation name for GraphQL — plus its read/write classification, and
// NOT its name. Tool names are a deterministic, contract-defined value
// (01-core §15: provider-safe `host_<path>` slugs), while the checked-in
// expectations carry the pre-freeze OpenAPI-operationId names
// (`getAdminTeams`). Keying on the identity is the "adapted names" the v0
// corpus requires, and still catches every real extraction defect: a missed
// surface drops recall, a mis-classified read/write breaks the key.
function actualToolIdentity(tool: ExtractedTool): string {
  if (tool.binding.kind === "trpc") return `trpc\t${tool.binding.procedure}`;
  if (tool.binding.kind === "graphql") return `graphql\t${tool.binding.operation}`;
  return `${tool.binding.method}\t${tool.binding.path}`;
}

function actualInventoryKey(tool: ExtractedTool): string {
  return `${actualToolIdentity(tool)}\t${tool.risk === "read" ? "read" : "write"}`;
}

function expectedInventoryKey(item: RepoExpectations["tools"][number]): string {
  return `${expectedToolIdentity(item)}\t${item.readOrWrite}`;
}

function scoreTools(expected: RepoExpectations, actualTools: readonly ExtractedTool[]): WeightedResult {
  const expectedInventories = expected.tools;
  const expectedKeys = new Set(expectedInventories.map(expectedInventoryKey));
  const actualKeys = actualTools.map(actualInventoryKey);
  const actualMatches = actualKeys.filter((key) => expectedKeys.has(key)).length;
  const expectedMatches = expectedInventories.filter((tool) => actualKeys.includes(expectedInventoryKey(tool))).length;
  const precision = actualTools.length === 0 ? 1 : actualMatches / actualTools.length;
  const recall = expected.tools.length === 0 ? 1 : expectedMatches / expected.tools.length;

  return {
    points: precision + recall,
    total: 2,
    checks: [
      {
        id: "tools.precision",
        pass: precision === 1,
        detail: `${actualMatches}/${actualTools.length} generated tools matched expected inventory; precision ${precision.toFixed(3)}`,
      },
      {
        id: "tools.recall",
        pass: recall === 1,
        detail: `${expectedMatches}/${expected.tools.length} expected tools were generated; recall ${recall.toFixed(3)}`,
      },
    ],
  };
}

function expectedAnnotationMatches(expected: ExpectedToolAnnotation, actual: ExtractedTool | undefined): boolean {
  if (!actual) return false;
  const expectedRisk = expected.dangerous ? "destructive" : expected.mutating ? "write" : "read";
  return actual.risk === expectedRisk;
}

/** A tRPC or GraphQL mutation is write-shaped exactly like a POST; a query
 * like a GET. */
function effectiveWriteMethod(tool: ExtractedTool): string {
  if (tool.binding.kind === "trpc" || tool.binding.kind === "graphql") {
    return tool.binding.type === "query" ? "GET" : "POST";
  }
  return tool.binding.method;
}

function isUnsafeAutoAllowed(tool: ExtractedTool): boolean {
  const method = effectiveWriteMethod(tool);
  if (WRITE_METHODS.has(method) && tool.risk === "read") return true;
  if ((method === "DELETE" || DESTRUCTIVE_NAME.test(tool.name)) && tool.risk !== "destructive") return true;
  return false;
}

function scoreAnnotations(expected: RepoExpectations, actualTools: readonly ExtractedTool[]): WeightedResult {
  // Names changed by contract (§15), so join by binding identity: the
  // annotation's name resolves to an expected tool's identity within the
  // expectations, and that identity finds the actual tool.
  const expectedByName = new Map(expected.tools.map((tool) => [tool.name, tool]));
  const actualByIdentity = new Map(actualTools.map((tool) => [actualToolIdentity(tool), tool]));
  const resolveActual = (annotationName: string): ExtractedTool | undefined => {
    const item = expectedByName.get(annotationName);
    return item ? actualByIdentity.get(expectedToolIdentity(item)) : undefined;
  };
  const matched = expected.annotations.filter((annotation) => expectedAnnotationMatches(annotation, resolveActual(annotation.name))).length;
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

async function readActualTheme(repoDir: string): Promise<VendoTheme> {
  const parsed = vendoThemeSchema.safeParse(await readJsonFile(path.join(repoDir, ".vendo/theme.json")));
  if (!parsed.success) throw new Error(`.vendo/theme.json schema error: ${parsed.error.issues[0]?.message ?? "invalid theme"}`);
  return parsed.data;
}

async function readActualTools(repoDir: string): Promise<ExtractedTool[]> {
  const parsed = toolsFileSchema.safeParse(await readJsonFile(path.join(repoDir, ".vendo/tools.json")));
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

  let actualTheme: VendoTheme;
  let actualTools: ExtractedTool[];
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
