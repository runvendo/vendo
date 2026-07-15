import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  validateCapabilities,
  capabilitiesFileSchema,
  overridesFileSchema,
  toolsFileSchema,
  type CapabilitiesFile,
  type CapabilityBrief,
  type CompoundTool,
  type ExtractedTool,
  type OverridesFile,
  type PrimitiveStepTarget,
  type ToolOverride,
} from "@vendoai/actions";
import {
  TOOL_NAME_PATTERN,
  VENDO_CAPABILITIES_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  capabilityMissEventSchema,
  type CapabilityMissEvent,
  type RiskLabel,
  type Step,
} from "@vendoai/core";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * The refine engine (ENG-250, extraction spec §3). One engine, two surfaces:
 * the `vendo refine` CLI command and the end-of-init offer — both call
 * `runRefine`. The engine PROPOSES agent-layer artifacts as reviewable diffs
 * (never silently applied, never touching deterministic `tools.json`):
 *
 *   - compound capabilities + capability briefs → `.vendo/capabilities.json`
 *   - risk corrections, enable/disable curation, description improvements
 *     → `.vendo/overrides.json`
 *   - product-brief updates → `.vendo/brief.md`
 *
 * Loop: propose (one BYO-model `generateObject` call over the static
 * extraction output, bounded source context, the miss feed, and the dev
 * interview) → probe each proposed capability against the running dev app
 * (doctor machinery: `/status`, plus read-step reachability — write steps are
 * NEVER executed by the probe) → present diffs → the caller applies approved
 * files.
 *
 * Cloud seam (designed, not built): every input is injectable
 * (`misses`, `interview`, `fetchImpl`) and the run emits a `RefineTranscript`
 * so the identical engine can execute in a hosted sandbox later.
 */

const RISK_ORDER: Record<RiskLabel, number> = { read: 0, write: 1, destructive: 2 };

const DEFAULT_SOURCE_BUDGET = 48_000;
const MAX_FILE_CHARS = 4_000;
const MAX_TREE_ENTRIES = 400;
const DEFAULT_MAX_MISSES = 50;

export interface RefineOptions {
  /** Host app root: `.vendo/` artifacts and source are read from here. */
  root: string;
  /** BYO ai-SDK model — the same provider-agnostic seam as `createVendo({ model })`. */
  model: LanguageModel;
  /** Mounted Vendo wire base of the running dev app (e.g. http://localhost:3000/api/vendo). */
  url?: string;
  fetchImpl?: typeof fetch;
  /** Dev-interview answers (the CLI collects them; a hosted run passes transcripts). */
  interview?: string[];
  /** Injected miss feed; default reads `.vendo/data/misses.jsonl`. */
  misses?: CapabilityMissEvent[];
  /** Char budget for the source-context leg. */
  sourceBudget?: number;
  maxMisses?: number;
}

export interface RefineProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RefineProbe {
  tool: string;
  /** verified = at least one live check passed and none failed; static-only = no live check possible. */
  status: "verified" | "static-only" | "failed";
  checks: RefineProbeCheck[];
}

export interface RefineChange {
  /** Path relative to root (e.g. `.vendo/capabilities.json`). */
  path: string;
  before: string | null;
  after: string;
  diff: string;
  /** Human-visible cautions (e.g. a proposed risk downgrade) shown beside the diff. */
  warnings: string[];
}

export interface RefineDrop {
  kind: "compound" | "brief" | "override" | "description" | "brief-update";
  target: string;
  reason: string;
}

/** The cloud-seam run record: inputs digest, raw proposals, probe results, and
 * (once the caller applies) decisions. Plain JSON under `.vendo/data/refine/`
 * — deliberately NOT a `vendo/*@N` contract format. */
export interface RefineTranscript {
  version: 0;
  startedAt: string;
  root: string;
  url?: string;
  inputs: {
    tools: number;
    misses: number;
    interview: string[];
    sourceFiles: string[];
  };
  proposals: RefineProposals;
  dropped: RefineDrop[];
  probes: RefineProbe[];
  decisions: Array<{ path: string; applied: boolean }>;
}

export interface RefineResult {
  changes: RefineChange[];
  probes: RefineProbe[];
  dropped: RefineDrop[];
  transcript: RefineTranscript;
}

// ---------------------------------------------------------------------------
// Proposal schema — what the model returns from the single generateObject call.
// ---------------------------------------------------------------------------

const proposalStepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string()).optional(),
  if: z.string().optional(),
  forEach: z.string().optional(),
});

const proposalsSchema = z.object({
  compounds: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.unknown()).optional(),
    steps: z.array(proposalStepSchema).min(1).max(50),
    rationale: z.string().optional(),
  })).optional(),
  briefs: z.array(z.object({
    name: z.string(),
    text: z.string(),
    tools: z.array(z.string()).optional(),
  })).optional(),
  riskCorrections: z.array(z.object({
    tool: z.string(),
    risk: z.enum(["read", "write", "destructive"]),
    reason: z.string().optional(),
  })).optional(),
  curation: z.array(z.object({
    tool: z.string(),
    disabled: z.boolean(),
    reason: z.string().optional(),
  })).optional(),
  descriptions: z.array(z.object({
    tool: z.string(),
    description: z.string(),
  })).optional(),
  briefUpdate: z.string().optional(),
});

export type RefineProposals = z.infer<typeof proposalsSchema>;

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

interface RefineInputs {
  tools: ExtractedTool[];
  overrides: OverridesFile | null;
  capabilities: CapabilitiesFile | null;
  brief: string | null;
  misses: CapabilityMissEvent[];
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function loadInputs(root: string, options: RefineOptions): Promise<RefineInputs> {
  const vendoDir = join(root, ".vendo");
  const toolsRaw = await readOptionalFile(join(vendoDir, "tools.json"));
  if (toolsRaw === null) {
    throw new Error("refine needs .vendo/tools.json — run `vendo init` (or `vendo sync`) first");
  }
  const tools = toolsFileSchema.parse(JSON.parse(toolsRaw)).tools;

  const overridesRaw = await readOptionalFile(join(vendoDir, "overrides.json"));
  const overrides = overridesRaw === null ? null : overridesFileSchema.parse(JSON.parse(overridesRaw));

  const capabilitiesRaw = await readOptionalFile(join(vendoDir, "capabilities.json"));
  const capabilities = capabilitiesRaw === null ? null : capabilitiesFileSchema.parse(JSON.parse(capabilitiesRaw));

  const brief = await readOptionalFile(join(vendoDir, "brief.md"));

  let misses = options.misses;
  if (misses === undefined) {
    misses = [];
    const missesRaw = await readOptionalFile(join(vendoDir, "data", "misses.jsonl"));
    if (missesRaw !== null) {
      for (const line of missesRaw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          misses.push(capabilityMissEventSchema.parse(JSON.parse(line)));
        } catch {
          // A malformed feed line never sinks the run.
        }
      }
    }
  }
  const maxMisses = options.maxMisses ?? DEFAULT_MAX_MISSES;
  return { tools, overrides, capabilities, brief, misses: misses.slice(-maxMisses) };
}

/** Post-override-merge primitive targets — the same view the registry loads,
 * so write-time validation agrees with load-time quarantine (04 §6). */
function mergedPrimitives(inputs: RefineInputs): Map<string, PrimitiveStepTarget> {
  const primitives = new Map<string, PrimitiveStepTarget>();
  for (const tool of inputs.tools) {
    const override = inputs.overrides?.tools[tool.name];
    primitives.set(tool.name, {
      risk: override?.risk ?? tool.risk,
      disabled: override?.disabled ?? tool.disabled,
    });
  }
  return primitives;
}

// ---------------------------------------------------------------------------
// Source context — bounded, deterministic, prioritized toward API surfaces.
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", ".vendo", "dist", "build", "out", "coverage",
]);

interface SourceContext {
  tree: string[];
  files: Array<{ path: string; content: string }>;
}

function sourcePriority(path: string): number {
  const segments = path.split("/");
  if (segments.some((part) => part === "api" || part === "routes" || part === "server" || part === "actions")) return 0;
  if (segments.some((part) => part === "app" || part === "pages")) return 1;
  if (segments.some((part) => part === "components" || part === "client")) return 2;
  return 3;
}

async function collectSourcePaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(absolute);
      } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(absolute.slice(root.length + 1).split(sep).join("/"));
        if (found.length >= MAX_TREE_ENTRIES) return;
      }
      if (found.length >= MAX_TREE_ENTRIES) return;
    }
  };
  await walk(root);
  return found;
}

async function gatherSource(root: string, budget: number): Promise<SourceContext> {
  const tree = await collectSourcePaths(root);
  const ordered = [...tree].sort((left, right) =>
    sourcePriority(left) - sourcePriority(right) || left.localeCompare(right));
  const files: SourceContext["files"] = [];
  let used = 0;
  for (const path of ordered) {
    if (used >= budget) break;
    const raw = await readOptionalFile(join(root, ...path.split("/")));
    if (raw === null) continue;
    const content = raw.length > MAX_FILE_CHARS ? `${raw.slice(0, MAX_FILE_CHARS)}\n// … truncated` : raw;
    if (used + content.length > budget) continue;
    files.push({ path, content });
    used += content.length;
  }
  return { tree, files };
}

// ---------------------------------------------------------------------------
// Proposal generation — one model call.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are the Vendo refine engine. Vendo turns a host app's API into risk-labeled agent tools;",
  "deterministic extraction already produced the primitive tools you are given. Your job is to close",
  "the gap between what the host UI can do and what single tools can do, by proposing:",
  "",
  "1. compounds — multi-step capabilities the UI supports but no single tool covers. Each compound has",
  "   ordered steps; every step references an ENABLED primitive tool name from the provided list (never",
  "   another compound, never an unknown name). Step `args` values are JSONata expressions evaluated",
  "   against { args, steps, item }: `args.x` reads the compound's own input, `steps.<id>` reads a prior",
  "   step's output, and `item` is the current element inside a `forEach` step. `forEach` is a JSONata",
  "   expression that must produce an array (max 1000 items); `if` is a JSONata condition that skips the",
  "   step when false. Give each compound a JSON Schema `inputSchema` for its own arguments.",
  "2. briefs — short prose playbooks that teach the agent how to combine existing tools.",
  "3. riskCorrections — primitive tools whose extracted risk label (read/write/destructive) is wrong.",
  "4. curation — primitive tools to disable (internal/debug/dangerous surfaces) or re-enable.",
  "5. descriptions — clearer one-line descriptions for badly described primitive tools.",
  "6. briefUpdate — an improved full replacement for the product brief, only when clearly better.",
  "",
  `Tool names must match ${String(TOOL_NAME_PATTERN)} and not collide with existing tools.`,
  "Propose only what the provided source, misses, and interview genuinely support. Fewer, correct",
  "proposals beat many speculative ones. Return empty arrays when nothing is warranted.",
].join("\n");

async function propose(
  model: LanguageModel,
  inputs: RefineInputs,
  source: SourceContext,
  interview: string[],
): Promise<RefineProposals> {
  const prompt = JSON.stringify({
    productBrief: inputs.brief,
    tools: inputs.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: inputs.overrides?.tools[tool.name]?.risk ?? tool.risk,
      disabled: inputs.overrides?.tools[tool.name]?.disabled ?? tool.disabled ?? false,
      inputSchema: tool.inputSchema,
    })),
    existingCompounds: (inputs.capabilities?.tools ?? []).map((tool) => tool.name),
    existingBriefs: (inputs.capabilities?.briefs ?? []).map((brief) => brief.name),
    capabilityMisses: inputs.misses.map((miss) => ({ intent: miss.intent, trigger: miss.trigger.kind })),
    interview,
    sourceTree: source.tree,
    sourceFiles: source.files,
  });
  const result = await generateObject({ model, schema: proposalsSchema, system: SYSTEM_PROMPT, prompt });
  return result.object;
}

// ---------------------------------------------------------------------------
// Deterministic normalization — the engine never trusts model-declared risk.
// ---------------------------------------------------------------------------

interface NormalizedProposals {
  compounds: CompoundTool[];
  briefs: CapabilityBrief[];
  overridePatches: Map<string, ToolOverride>;
  overrideWarnings: string[];
  briefUpdate: string | undefined;
  dropped: RefineDrop[];
}

function normalize(proposals: RefineProposals, inputs: RefineInputs): NormalizedProposals {
  const dropped: RefineDrop[] = [];
  const primitives = mergedPrimitives(inputs);
  const existingCompoundNames = new Set((inputs.capabilities?.tools ?? []).map((tool) => tool.name));

  const compounds: CompoundTool[] = [];
  const acceptedNames = new Set<string>();
  for (const candidate of proposals.compounds ?? []) {
    const drop = (reason: string): void => { dropped.push({ kind: "compound", target: candidate.name, reason }); };
    if (!TOOL_NAME_PATTERN.test(candidate.name)) { drop(`name does not match ${String(TOOL_NAME_PATTERN)}`); continue; }
    if (primitives.has(candidate.name)) { drop("name collides with an extracted tool"); continue; }
    if (existingCompoundNames.has(candidate.name)) { drop("name collides with an existing compound"); continue; }
    if (acceptedNames.has(candidate.name)) { drop("duplicate proposal name"); continue; }
    if (new Set(candidate.steps.map((step) => step.id)).size !== candidate.steps.length) {
      drop("step ids must be unique");
      continue;
    }
    let maxRisk: RiskLabel = "read";
    let stepsValid = true;
    for (const step of candidate.steps) {
      const target = primitives.get(step.tool);
      if (target === undefined) { drop(`step ${step.id} references unknown tool ${step.tool}`); stepsValid = false; break; }
      if (target.disabled === true) { drop(`step ${step.id} references disabled tool ${step.tool}`); stepsValid = false; break; }
      if (RISK_ORDER[target.risk] > RISK_ORDER[maxRisk]) maxRisk = target.risk;
    }
    if (!stepsValid) continue;
    const steps: Step[] = candidate.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      ...(step.args === undefined ? {} : { args: step.args }),
      ...(step.if === undefined ? {} : { if: step.if }),
      ...(step.forEach === undefined ? {} : { forEach: step.forEach }),
    }));
    acceptedNames.add(candidate.name);
    compounds.push({
      name: candidate.name,
      description: candidate.description,
      inputSchema: candidate.inputSchema ?? { type: "object" },
      // Descriptor risk = max of step risks, computed HERE (validated again below
      // and at load) — the model's opinion of risk is never trusted.
      risk: maxRisk,
      binding: { kind: "compound", steps },
      note: "authored by vendo refine",
    });
  }

  // Final gate: the SAME semantic validation the registry runs at load (04 §6).
  const candidateFile = { tools: [...(inputs.capabilities?.tools ?? []), ...compounds] };
  const issues = validateCapabilities(candidateFile, primitives);
  const invalid = new Map<string, string>();
  for (const issue of issues) {
    if (acceptedNames.has(issue.tool)) invalid.set(issue.tool, issue.message);
  }
  const validCompounds = compounds.filter((compound) => {
    const message = invalid.get(compound.name);
    if (message !== undefined) dropped.push({ kind: "compound", target: compound.name, reason: message });
    return message === undefined;
  });

  const existingBriefNames = new Set((inputs.capabilities?.briefs ?? []).map((brief) => brief.name));
  const briefs: CapabilityBrief[] = [];
  for (const candidate of proposals.briefs ?? []) {
    if (candidate.name.trim() === "" || candidate.text.trim() === "") {
      dropped.push({ kind: "brief", target: candidate.name || "(unnamed)", reason: "empty name or text" });
      continue;
    }
    if (existingBriefNames.has(candidate.name) || briefs.some((brief) => brief.name === candidate.name)) {
      dropped.push({ kind: "brief", target: candidate.name, reason: "brief already exists" });
      continue;
    }
    const knownTools = candidate.tools?.filter((tool) => primitives.has(tool) || acceptedNames.has(tool));
    briefs.push({
      name: candidate.name,
      text: candidate.text,
      ...(knownTools === undefined || knownTools.length === 0 ? {} : { tools: knownTools }),
    });
  }

  const overridePatches = new Map<string, ToolOverride>();
  const overrideWarnings: string[] = [];
  const patch = (tool: string, fields: ToolOverride): void => {
    overridePatches.set(tool, { ...overridePatches.get(tool), ...fields });
  };
  for (const correction of proposals.riskCorrections ?? []) {
    const current = primitives.get(correction.tool);
    if (current === undefined) {
      dropped.push({ kind: "override", target: correction.tool, reason: "unknown tool" });
      continue;
    }
    if (current.risk === correction.risk) {
      dropped.push({ kind: "override", target: correction.tool, reason: `risk is already ${correction.risk}` });
      continue;
    }
    if (RISK_ORDER[correction.risk] < RISK_ORDER[current.risk]) {
      overrideWarnings.push(
        `risk DOWNGRADE proposed: ${correction.tool} ${current.risk} → ${correction.risk}`
          + `${correction.reason === undefined ? "" : ` (${correction.reason})`} — approve only if certain`,
      );
    }
    patch(correction.tool, { risk: correction.risk });
  }
  for (const curation of proposals.curation ?? []) {
    const current = primitives.get(curation.tool);
    if (current === undefined) {
      dropped.push({ kind: "override", target: curation.tool, reason: "unknown tool" });
      continue;
    }
    if ((current.disabled ?? false) === curation.disabled) {
      dropped.push({ kind: "override", target: curation.tool, reason: `already ${curation.disabled ? "disabled" : "enabled"}` });
      continue;
    }
    if (!curation.disabled) {
      overrideWarnings.push(`re-ENABLE proposed: ${curation.tool}${curation.reason === undefined ? "" : ` (${curation.reason})`}`);
    }
    patch(curation.tool, { disabled: curation.disabled });
  }
  for (const description of proposals.descriptions ?? []) {
    const extracted = inputs.tools.find((tool) => tool.name === description.tool);
    if (extracted === undefined) {
      dropped.push({ kind: "description", target: description.tool, reason: "unknown tool" });
      continue;
    }
    const currentDescription = inputs.overrides?.tools[description.tool]?.description ?? extracted.description;
    if (description.description.trim() === "" || description.description === currentDescription) {
      dropped.push({ kind: "description", target: description.tool, reason: "empty or unchanged description" });
      continue;
    }
    patch(description.tool, { description: description.description });
  }

  let briefUpdate = proposals.briefUpdate;
  if (briefUpdate !== undefined && (briefUpdate.trim() === "" || briefUpdate.trim() === inputs.brief?.trim())) {
    dropped.push({ kind: "brief-update", target: "brief.md", reason: "empty or unchanged brief" });
    briefUpdate = undefined;
  }

  return { compounds: validCompounds, briefs, overridePatches, overrideWarnings, briefUpdate, dropped };
}

// ---------------------------------------------------------------------------
// Probe — doctor machinery against the running dev app. Never mutating: only
// paramless GET read steps are executed; write steps stay static-only.
// ---------------------------------------------------------------------------

async function probeStatus(url: string, fetchImpl: typeof fetch): Promise<RefineProbeCheck> {
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, "")}/status`, { headers: { accept: "application/json" } });
    const body = await response.json() as { posture?: unknown; version?: unknown };
    if (response.ok && typeof body.posture === "string" && typeof body.version === "string") {
      return { name: "dev-app", ok: true, detail: `/status live (${body.version}, ${body.posture})` };
    }
    return { name: "dev-app", ok: false, detail: `/status returned an invalid composition response (${response.status})` };
  } catch {
    return { name: "dev-app", ok: false, detail: `/status is unreachable at ${url}` };
  }
}

interface LiveStepTarget {
  method: string;
  path: string;
}

/** A step is live-probeable only when it is READ risk and binds a paramless
 * GET — refine must never mutate the dev app. */
function liveTarget(binding: ExtractedTool["binding"]): LiveStepTarget | null {
  if (binding.kind === "route" && binding.method.toUpperCase() === "GET") {
    return { method: "GET", path: binding.path };
  }
  if (binding.kind === "openapi") {
    const method = (binding as { method?: string }).method?.toUpperCase();
    const path = (binding as { path?: string }).path;
    if (method === "GET" && typeof path === "string") return { method, path };
  }
  return null;
}

const hasPathParams = (path: string): boolean => /[{[:]/.test(path);

async function probeCompound(
  compound: CompoundTool,
  inputs: RefineInputs,
  statusCheck: RefineProbeCheck | null,
  origin: string | null,
  fetchImpl: typeof fetch,
): Promise<RefineProbe> {
  const primitives = mergedPrimitives(inputs);
  const byName = new Map(inputs.tools.map((tool) => [tool.name, tool]));
  const checks: RefineProbeCheck[] = [];
  if (statusCheck !== null) checks.push(statusCheck);

  // "verified" requires at least one live STEP check — a live /status alone
  // only proves the composition is up, not that this compound's surface exists.
  let live = false;
  for (const step of compound.binding.steps) {
    const label = `step ${step.id} (${step.tool})`;
    const target = primitives.get(step.tool);
    const extracted = byName.get(step.tool);
    if (target === undefined || extracted === undefined) {
      checks.push({ name: label, ok: false, detail: "not an extracted primitive tool" });
      continue;
    }
    if (target.risk !== "read") {
      checks.push({ name: label, ok: true, detail: `${target.risk} risk — not executed by the probe; validated statically` });
      continue;
    }
    const request = liveTarget(extracted.binding);
    if (request === null || hasPathParams(request.path) || origin === null || statusCheck?.ok !== true) {
      checks.push({ name: label, ok: true, detail: "read step not live-probeable here; validated statically" });
      continue;
    }
    try {
      const response = await fetchImpl(`${origin}${request.path}`, { headers: { accept: "application/json" } });
      if (response.status === 404 || response.status === 405 || response.status >= 500) {
        checks.push({ name: label, ok: false, detail: `GET ${request.path} → ${response.status}` });
      } else {
        const gated = response.status === 401 || response.status === 403 ? " (auth-gated)" : "";
        checks.push({ name: label, ok: true, detail: `GET ${request.path} → ${response.status}${gated}` });
        live = true;
      }
    } catch {
      checks.push({ name: label, ok: false, detail: `GET ${request.path} is unreachable` });
    }
  }

  // An unreachable dev app degrades to static-only (the diff is still worth
  // presenting); only a STEP-level probe failure marks the compound failed.
  const failed = checks.some((check) => check.name !== "dev-app" && !check.ok);
  return {
    tool: compound.name,
    status: failed ? "failed" : live ? "verified" : "static-only",
    checks,
  };
}

// ---------------------------------------------------------------------------
// Diff building — init's whole-file diff convention.
// ---------------------------------------------------------------------------

function renderDiff(path: string, before: string | null, after: string): string {
  const oldLines = before === null ? [] : before.trimEnd().split("\n");
  const newLines = after.trimEnd().split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

const stringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export async function runRefine(options: RefineOptions): Promise<RefineResult> {
  const root = resolve(options.root);
  const fetchImpl = options.fetchImpl ?? fetch;
  const interview = options.interview ?? [];
  const startedAt = new Date().toISOString();

  const inputs = await loadInputs(root, options);
  const source = await gatherSource(root, options.sourceBudget ?? DEFAULT_SOURCE_BUDGET);
  const proposals = await propose(options.model, inputs, source, interview);
  const normalized = normalize(proposals, inputs);

  // Probe: doctor's /status once, then per-compound verification. Compounds
  // that FAIL their probe are not offered as changes — the loop is
  // propose → probe → present → apply (spec §3).
  const statusCheck = options.url === undefined ? null : await probeStatus(options.url, fetchImpl);
  const origin = options.url === undefined ? null : new URL(options.url).origin;
  const probes: RefineProbe[] = [];
  const verified: CompoundTool[] = [];
  for (const compound of normalized.compounds) {
    const probe = await probeCompound(compound, inputs, statusCheck, origin, fetchImpl);
    probes.push(probe);
    if (probe.status === "failed") {
      normalized.dropped.push({
        kind: "compound",
        target: compound.name,
        reason: `probe failed: ${probe.checks.filter((check) => !check.ok).map((check) => check.detail).join("; ")}`,
      });
    } else {
      verified.push(compound);
    }
  }

  const changes: RefineChange[] = [];
  const vendoDir = join(root, ".vendo");

  if (verified.length > 0 || normalized.briefs.length > 0) {
    const beforeFile = inputs.capabilities;
    const afterFile: CapabilitiesFile = {
      format: VENDO_CAPABILITIES_FORMAT,
      ...beforeFile,
      tools: [...(beforeFile?.tools ?? []), ...verified],
      ...((beforeFile?.briefs ?? []).length + normalized.briefs.length > 0
        ? { briefs: [...(beforeFile?.briefs ?? []), ...normalized.briefs] }
        : {}),
    };
    const before = await readOptionalFile(join(vendoDir, "capabilities.json"));
    const after = stringify(afterFile);
    if (before !== after) {
      changes.push({
        path: ".vendo/capabilities.json",
        before,
        after,
        diff: renderDiff(".vendo/capabilities.json", before, after),
        warnings: [],
      });
    }
  }

  if (normalized.overridePatches.size > 0) {
    const beforeFile: OverridesFile = inputs.overrides ?? { format: VENDO_OVERRIDES_FORMAT, tools: {} };
    const tools: Record<string, ToolOverride> = { ...beforeFile.tools };
    for (const [tool, fields] of normalized.overridePatches) {
      tools[tool] = { ...tools[tool], ...fields };
    }
    const before = await readOptionalFile(join(vendoDir, "overrides.json"));
    const after = stringify({ ...beforeFile, tools });
    if (before !== after) {
      changes.push({
        path: ".vendo/overrides.json",
        before,
        after,
        diff: renderDiff(".vendo/overrides.json", before, after),
        warnings: normalized.overrideWarnings,
      });
    }
  }

  if (normalized.briefUpdate !== undefined) {
    const before = inputs.brief;
    const after = normalized.briefUpdate.endsWith("\n") ? normalized.briefUpdate : `${normalized.briefUpdate}\n`;
    if (before !== after) {
      changes.push({
        path: ".vendo/brief.md",
        before,
        after,
        diff: renderDiff(".vendo/brief.md", before, after),
        warnings: [],
      });
    }
  }

  const transcript: RefineTranscript = {
    version: 0,
    startedAt,
    root,
    ...(options.url === undefined ? {} : { url: options.url }),
    inputs: {
      tools: inputs.tools.length,
      misses: inputs.misses.length,
      interview,
      sourceFiles: source.files.map((file) => file.path),
    },
    proposals,
    dropped: normalized.dropped,
    probes,
    decisions: [],
  };

  return { changes, probes, dropped: normalized.dropped, transcript };
}
