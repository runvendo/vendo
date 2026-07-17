import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ScorecardCheck, ScorecardLayerInput, ScorecardScore } from "../scorecard.js";

/**
 * UI-parity audit layer (spec §6, ENG-257). An agent enumerates what the host
 * FRONTEND lets a user do, and that enumeration is diffed against the extracted
 * plus refined tool surface (`.vendo/tools.json` primitives + the compounds and
 * briefs in `.vendo/capabilities.json`) to produce a per-repo coverage metric.
 *
 * The layer is LLM-costed and NIGHTLY-ONLY, exactly like the Layer 3 scored
 * pass@k run — it never rides the PR path (ci.yml). The live enumeration is a
 * single injected seam (`UiParityEnumerator`); everything below it — surface
 * loading, the diff, the coverage metric, the scorecard summary — is pure and
 * unit-tested with a mocked enumerator. `createLlmEnumerator` is the only piece
 * that talks to a model, and it takes the model + a `generateText`-shaped
 * callable as injected dependencies so this module needs no ai-SDK dependency.
 */

export const UI_PARITY_LAYER = 4;
export const UI_PARITY_LAYER_NAME = "ui-parity";

/** A single user-facing action the frontend exposes, as enumerated by the agent. */
export interface UiCapability {
  /** Stable slug within a repo, e.g. `bulk-paste-range`. */
  id: string;
  title: string;
  description: string;
  /** Whether performing it changes host data. */
  kind: "read" | "write";
  /**
   * Names drawn from the provided tool surface that the agent believes cover
   * this capability. Empty means the agent found no covering tool: a genuine
   * gap. Names not present in the surface are phantom claims (hallucinations)
   * and are treated as not covering.
   */
  expectedTools: string[];
}

export interface UiParityEnumeration {
  capabilities: UiCapability[];
}

export interface FrontendSource {
  path: string;
  text: string;
}

export type SurfaceEntryKind = "tool" | "compound" | "brief";

export interface SurfaceEntry {
  name: string;
  kind: SurfaceEntryKind;
  risk?: string;
  /** Disabled entries are excluded from the available surface used for coverage. */
  disabled: boolean;
}

export interface UiParityEnumeratorInput {
  repoName: string;
  frontendSources: FrontendSource[];
  /** Only the enabled surface entries the capability can legitimately cite. */
  surface: SurfaceEntry[];
}

export type UiParityEnumerator = (input: UiParityEnumeratorInput) => Promise<UiParityEnumeration>;

export type UiParityEntryStatus = "covered" | "gap" | "phantom";

export interface UiParityEntry {
  capability: UiCapability;
  status: UiParityEntryStatus;
  matchedTools: string[];
  missingTools: string[];
}

export interface UiParityCoverage {
  entries: UiParityEntry[];
  coverage: ScorecardScore;
  gaps: UiParityEntry[];
  phantoms: UiParityEntry[];
}

export interface UiParityLayerContext {
  repoName: string;
  repoDir: string;
  enumerate: UiParityEnumerator;
  logsDir?: string;
  /** Test seam: override frontend source collection. */
  readFrontendSources?: (repoDir: string) => Promise<FrontendSource[]>;
  maxFiles?: number;
  maxBytesPerFile?: number;
  now?: () => Date;
}

export interface UiParityLayerRunResult {
  layer: ScorecardLayerInput;
  coverage: UiParityCoverage;
  surface: SurfaceEntry[];
  capabilities: UiCapability[];
  logPath?: string;
}

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_BYTES_PER_FILE = 12_000;
const FRONTEND_DIRS = ["src", "app", "pages", "components", "features"];
const SOURCE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".vendo",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  "coverage",
  "__tests__",
  "e2e",
]);

function round(value: number): number {
  return Number(value.toFixed(6));
}

function scoreOf(covered: number, total: number): ScorecardScore {
  return {
    passed: covered,
    total,
    // Vacuously fully-covered when the agent enumerated nothing: there are no
    // uncovered capabilities. Callers surface the empty enumeration separately.
    value: total === 0 ? 1 : round(covered / total),
  };
}

/**
 * Pure coverage diff. A capability is covered when at least one of its claimed
 * tools actually exists in the enabled surface; it is a phantom when it claims
 * tools but none exist (agent hallucinated the coverage); it is a gap when the
 * agent claimed no covering tool at all.
 */
export function diffUiParity(
  capabilities: readonly UiCapability[],
  surfaceNames: ReadonlySet<string>,
): UiParityCoverage {
  const entries: UiParityEntry[] = capabilities.map((capability) => {
    const matchedTools = capability.expectedTools.filter((name) => surfaceNames.has(name));
    const missingTools = capability.expectedTools.filter((name) => !surfaceNames.has(name));
    const status: UiParityEntryStatus = matchedTools.length > 0
      ? "covered"
      : capability.expectedTools.length > 0
        ? "phantom"
        : "gap";
    return { capability, status, matchedTools, missingTools };
  });
  const covered = entries.filter((entry) => entry.status === "covered").length;
  return {
    entries,
    coverage: scoreOf(covered, entries.length),
    gaps: entries.filter((entry) => entry.status !== "covered"),
    // Only genuinely-phantom entries (claimed tools, none real) — a covered
    // capability that happens to also claim a missing tool is NOT a phantom, so
    // partial coverage is never double-counted. Its stray claim stays visible
    // on the entry's own `missingTools`.
    phantoms: entries.filter((entry) => entry.status === "phantom"),
  };
}

export function summarizeUiParity(coverage: UiParityCoverage, logPaths: readonly string[] = []): ScorecardLayerInput {
  const checks: ScorecardCheck[] = coverage.entries.map((entry) => ({
    id: `ui-parity.${entry.capability.id}`,
    pass: entry.status === "covered",
    detail: entry.status === "covered"
      ? `covered by ${entry.matchedTools.join(", ")}`
      : entry.status === "gap"
        ? `no covering tool enumerated (${entry.capability.kind})`
        : `phantom coverage; claimed missing tool(s): ${entry.missingTools.join(", ")}`,
  }));
  const gapDetail = coverage.gaps.length === 0
    ? "no gaps"
    : `${coverage.gaps.length} gap(s): ${coverage.gaps.map((entry) => entry.capability.id).join(", ")}`;
  return {
    // Nightly, informational: it reports a metric and never hard-fails a run.
    layer: UI_PARITY_LAYER,
    name: UI_PARITY_LAYER_NAME,
    status: "pass",
    score: coverage.coverage,
    checks,
    detail: `frontend/tool coverage ${coverage.coverage.value.toFixed(3)} (${coverage.coverage.passed}/${coverage.coverage.total}); ${gapDetail}`,
    logPaths,
    hardFailure: false,
  };
}

async function readOptionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load the extracted + refined surface loosely (never throws on a shape the
 * strict schemas would reject — a real repo's generated files are the input,
 * not a fixture). Extracted primitives come from `.vendo/tools.json`; refined
 * compounds and briefs come from `.vendo/capabilities.json`; `.vendo/overrides.json`
 * disables are honored so a disabled tool is not counted as available coverage.
 */
export async function loadSurface(repoDir: string): Promise<SurfaceEntry[]> {
  const vendoDir = path.join(repoDir, ".vendo");
  const toolsDoc = await readOptionalJson(path.join(vendoDir, "tools.json"));
  const capsDoc = await readOptionalJson(path.join(vendoDir, "capabilities.json"));
  const overridesDoc = await readOptionalJson(path.join(vendoDir, "overrides.json"));

  const overrideDisabled = new Set<string>();
  if (isRecord(overridesDoc) && isRecord(overridesDoc.tools)) {
    for (const [name, value] of Object.entries(overridesDoc.tools)) {
      if (isRecord(value) && value.disabled === true) overrideDisabled.add(name);
    }
  }

  const entries: SurfaceEntry[] = [];
  const seen = new Set<string>();
  const push = (name: unknown, kind: SurfaceEntryKind, risk: unknown, disabledFlag: unknown): void => {
    if (typeof name !== "string" || name === "" || seen.has(name)) return;
    seen.add(name);
    entries.push({
      name,
      kind,
      risk: typeof risk === "string" ? risk : undefined,
      disabled: disabledFlag === true || overrideDisabled.has(name),
    });
  };

  const toolsArray = isRecord(toolsDoc) && Array.isArray(toolsDoc.tools)
    ? toolsDoc.tools
    : Array.isArray(toolsDoc) ? toolsDoc : [];
  for (const tool of toolsArray) {
    if (isRecord(tool)) push(tool.name, "tool", tool.risk, tool.disabled);
  }
  if (isRecord(capsDoc)) {
    if (Array.isArray(capsDoc.tools)) {
      for (const tool of capsDoc.tools) {
        if (isRecord(tool)) push(tool.name, "compound", tool.risk, tool.disabled);
      }
    }
    if (Array.isArray(capsDoc.briefs)) {
      for (const brief of capsDoc.briefs) {
        if (isRecord(brief)) push(brief.name, "brief", undefined, false);
      }
    }
  }
  return entries;
}

async function walkFrontend(
  dir: string,
  budget: { files: number; maxFiles: number; maxBytesPerFile: number },
  out: FrontendSource[],
  repoDir: string,
): Promise<void> {
  if (budget.files >= budget.maxFiles) return;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const dirent of dirents) {
    if (budget.files >= budget.maxFiles) return;
    if (dirent.name.startsWith(".") && dirent.name !== ".vendo") {
      if (dirent.isDirectory()) continue;
    }
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      await walkFrontend(full, budget, out, repoDir);
      continue;
    }
    const ext = path.extname(dirent.name);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(dirent.name)) continue;
    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch {
      continue;
    }
    out.push({
      path: path.relative(repoDir, full).split(path.sep).join("/"),
      text: text.length > budget.maxBytesPerFile ? text.slice(0, budget.maxBytesPerFile) : text,
    });
    budget.files += 1;
  }
}

export async function collectFrontendSources(
  repoDir: string,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE,
): Promise<FrontendSource[]> {
  const out: FrontendSource[] = [];
  const budget = { files: 0, maxFiles, maxBytesPerFile };
  const roots = FRONTEND_DIRS.map((dir) => path.join(repoDir, dir));
  for (const root of roots) {
    await walkFrontend(root, budget, out, repoDir);
  }
  // Fall back to the repo root when none of the conventional dirs exist.
  if (out.length === 0) await walkFrontend(repoDir, budget, out, repoDir);
  return out;
}

export async function runUiParityLayer(ctx: UiParityLayerContext): Promise<UiParityLayerRunResult> {
  const surface = await loadSurface(ctx.repoDir);
  const enabledSurface = surface.filter((entry) => !entry.disabled);
  const frontendSources = await (ctx.readFrontendSources ?? ((dir) =>
    collectFrontendSources(dir, ctx.maxFiles ?? DEFAULT_MAX_FILES, ctx.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE)))(ctx.repoDir);

  const enumeration = await ctx.enumerate({
    repoName: ctx.repoName,
    frontendSources,
    surface: enabledSurface,
  });

  const surfaceNames = new Set(enabledSurface.map((entry) => entry.name));
  const coverage = diffUiParity(enumeration.capabilities, surfaceNames);

  let logPath: string | undefined;
  if (ctx.logsDir) {
    await mkdir(ctx.logsDir, { recursive: true });
    logPath = path.join(ctx.logsDir, "ui-parity.json");
    await writeFile(
      logPath,
      `${JSON.stringify({
        version: 1,
        repo: ctx.repoName,
        generatedAt: (ctx.now ?? (() => new Date()))().toISOString(),
        surface: enabledSurface,
        coverage,
      }, null, 2)}\n`,
    );
  }

  return {
    layer: summarizeUiParity(coverage, logPath ? [logPath] : []),
    coverage,
    surface: enabledSurface,
    capabilities: enumeration.capabilities,
    logPath,
  };
}

const capabilitySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(["read", "write"]),
  expectedTools: z.array(z.string().min(1)).default([]),
});

const enumerationSchema = z.object({
  capabilities: z.array(capabilitySchema),
});

/** Extract a JSON object from a model response that may wrap it in prose or a
 * fenced code block. */
export function extractEnumerationJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("ui-parity enumerator returned no JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export interface GenerateTextLike {
  (options: { model: unknown; prompt: string; maxOutputTokens?: number }): Promise<{ text: string }>;
}

export interface LlmEnumeratorDeps {
  model: unknown;
  generateText: GenerateTextLike;
  maxOutputTokens?: number;
}

export function buildEnumeratorPrompt(input: UiParityEnumeratorInput): string {
  const surfaceList = input.surface
    .map((entry) => `- ${entry.name} [${entry.kind}${entry.risk ? `, ${entry.risk}` : ""}]`)
    .join("\n");
  const sources = input.frontendSources
    .map((source) => `--- ${source.path} ---\n${source.text}`)
    .join("\n\n");
  return [
    `You are auditing the frontend of the app "${input.repoName}" for UI/tool parity.`,
    "Enumerate the distinct user-facing actions the FRONTEND lets a user perform (both reads and writes).",
    "For each action, decide whether the extracted/refined agent tool surface below can perform it, and list the covering tool name(s) from that surface. If NO tool covers it, return an empty expectedTools array — that is a genuine gap.",
    "Only cite tool names that appear verbatim in the surface list.",
    "",
    "TOOL SURFACE (extracted primitives + refined compounds/briefs):",
    surfaceList || "(empty surface)",
    "",
    "FRONTEND SOURCE (truncated):",
    sources || "(no frontend sources found)",
    "",
    "Respond with STRICT JSON only, no prose, in this shape:",
    '{"capabilities":[{"id":"kebab-slug","title":"...","description":"...","kind":"read|write","expectedTools":["tool_name"]}]}',
  ].join("\n");
}

/** The live, nightly enumerator. The model + a `generateText`-shaped callable
 * are injected so this module carries no ai-SDK dependency; the nightly driver
 * wires them from the host's provider-agnostic seam (BYO key). */
export function createLlmEnumerator(deps: LlmEnumeratorDeps): UiParityEnumerator {
  return async (input) => {
    const { text } = await deps.generateText({
      model: deps.model,
      prompt: buildEnumeratorPrompt(input),
      maxOutputTokens: deps.maxOutputTokens ?? 4_000,
    });
    return enumerationSchema.parse(extractEnumerationJson(text));
  };
}
