import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeOverrides } from "@vendoai/actions/sync";
import {
  VENDO_TOOLS_FORMAT,
  overridesFileSchema,
  toolsFileSchema,
  type OverridesFile,
} from "@vendoai/actions";
// TEMP: deleted by judgment-layer lane C2 — local copies of the enrichment
// helpers and the two dropped tools.json fields (see temp-enrichment.ts).
import {
  gitTreeHash,
  clampEnrichment,
  applyEnrichmentFields,
  type WatermarkedToolsFile,
} from "./temp-enrichment.js";
import { readOptional } from "../shared.js";
import type { ExtractionDraft } from "../extract/harness.js";
import type { ExtractionHarness } from "../extract/harness.js";
import { computeEnrichmentDiff, OBJECT_ID, type ComputeDiffOptions, type EnrichmentDiff } from "./diff.js";
import {
  resolveEnrichmentEngine,
  runEnrichment,
  type EnrichmentOutcome,
  type ResolveEngineOptions,
} from "./engine.js";

/**
 * The sync-time orchestration of the AI enrichment pass (cse lane 1c):
 * read the freshly written structural `.vendo/tools.json`, decide what is
 * affected (diff since the watermark + srcHash changes + the never-enriched
 * backlog), run the engine, clamp, APPLY-THEN-SHOW (write, then print the
 * sectioned narrative; `--review` flips the order and asks first), and move
 * the watermark to the current tree on success. Keyless resolves to
 * structural-only with one calm line — today's behavior, zero errors.
 */

export interface PreviousToolsState {
  watermark?: string;
  /** name → srcHash of the PREVIOUS sync (all tools present, hash optional). */
  srcHashes: Map<string, string | undefined>;
  enriched: Set<string>;
}

/** Tolerant pre-sync snapshot: the caller reads this BEFORE the structural
 *  sync overwrites tools.json, so the pass can tell which srcHashes moved. */
export async function readPreviousToolsState(vendoDir: string): Promise<PreviousToolsState | null> {
  const raw = await readOptional(join(vendoDir, "tools.json"));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if ((parsed as { format?: unknown }).format !== VENDO_TOOLS_FORMAT) return null;
    const file = toolsFileSchema.parse(parsed) as WatermarkedToolsFile;
    // Belt-and-suspenders: never carry a non-object-id watermark past the
    // read boundary (defence in depth with computeEnrichmentDiff's OBJECT_ID
    // guard). A tampered value is dropped, degrading to full mode.
    const watermark = file.watermark !== undefined && OBJECT_ID.test(file.watermark) ? file.watermark : undefined;
    return {
      ...(watermark === undefined ? {} : { watermark }),
      srcHashes: new Map(file.tools.map((tool) => [tool.name, tool.srcHash])),
      enriched: new Set(file.tools.filter((tool) => tool.enriched === true).map((tool) => tool.name)),
    };
  } catch {
    return null; // migration/first-sync cases — the pass treats it as full mode
  }
}

async function readToolsFile(vendoDir: string): Promise<WatermarkedToolsFile | null> {
  const raw = await readOptional(join(vendoDir, "tools.json"));
  if (raw === null) return null;
  try {
    // Both schemas are passthrough, so the two fields C2 will delete for real
    // still round-trip through parse.
    return toolsFileSchema.parse(JSON.parse(raw)) as WatermarkedToolsFile;
  } catch {
    return null;
  }
}

/** Read-only context for the model: human overrides always win. Never throws
 *  — a malformed overrides file already failed the structural sync loudly. */
async function readOverridesContext(vendoDir: string): Promise<OverridesFile | null> {
  const raw = await readOptional(join(vendoDir, "overrides.json"));
  if (raw === null) return null;
  try {
    return overridesFileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeToolsFile(vendoDir: string, file: WatermarkedToolsFile, watermark: string | undefined): Promise<void> {
  const { watermark: _previous, ...rest } = file;
  const next = toolsFileSchema.parse({
    ...rest,
    ...(watermark === undefined ? {} : { watermark }),
  });
  await writeFile(join(vendoDir, "tools.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

const listed = (names: string[], limit = 10): string =>
  names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;

/** Strip terminal control characters (C0 except tab, DEL, C1) from any
 *  model-ORIGINATED text before it reaches the operator's terminal. Hostile
 *  repo content can steer the model into ANSI/OSC escapes that would spoof
 *  the very narrative the dev reviews under apply-then-show. Tool-name and
 *  enum lines (clamp refusals, counts) are already pattern-constrained and
 *  stay verbatim. */
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to strip them
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const sanitize = (line: string): string => line.replace(CONTROL_CHARS, "");

/** The sectioned change narrative (deliverable: new / changed / restricted-by-
 *  clamp / unenriched-stale), followed by the model's own prose. */
export function buildEnrichmentNarrative(input: {
  credential: string;
  outcome: EnrichmentOutcome;
  candidates: { added: string[]; changed: string[]; unenriched: string[] };
}): string[] {
  const { outcome, candidates } = input;
  const added = outcome.applied.filter((name) => candidates.added.includes(name));
  const changed = outcome.applied.filter((name) => !candidates.added.includes(name));
  const lines: string[] = [`enrichment (${input.credential}): ${outcome.applied.length} tools updated`];
  if (added.length > 0) lines.push(`  new tools (${added.length}): ${listed(added)}`);
  if (changed.length > 0) lines.push(`  changed tools (${changed.length}): ${listed(changed)}`);
  if (outcome.clamped.length > 0) {
    lines.push(`  restricted by clamp (${outcome.clamped.length}):`);
    for (const entry of outcome.clamped) {
      for (const refusal of entry.refusals) lines.push(`    ${refusal}`);
    }
  }
  const staleSet = new Set(outcome.stale);
  const neverEnriched = outcome.unenriched.filter((name) => !staleSet.has(name));
  if (outcome.stale.length > 0 || neverEnriched.length > 0) {
    const parts = [
      ...(outcome.stale.length > 0 ? [`stale (source changed, unaccounted): ${listed(outcome.stale)}`] : []),
      ...(neverEnriched.length > 0 ? [`never enriched: ${listed(neverEnriched)}`] : []),
    ];
    lines.push(`  unenriched / stale (${outcome.stale.length + neverEnriched.length}): ${parts.join(" · ")}`);
  }
  // Model-originated lines (engine notes may echo harness/error strings; the
  // narrative is free-form prose) are sanitized; the constrained lines above
  // are left verbatim.
  for (const note of outcome.notes) lines.push(`  ${sanitize(note)}`);
  if (outcome.modelNarrative.length > 0) {
    for (const line of outcome.modelNarrative.split("\n")) lines.push(`  ${sanitize(line)}`);
  }
  return lines;
}

export interface SyncEnrichmentOptions {
  root: string;
  vendoDir: string;
  env: Record<string, string | undefined>;
  /** Human/notes channel (sync --json folds these into `notes`). */
  note: (line: string) => void;
  /** Warning channel (stderr in human mode) — exit code never changes. */
  warn: (line: string) => void;
  /** Pre-sync snapshot (readPreviousToolsState BEFORE the structural sync). */
  previous: PreviousToolsState | null;
  /** --full: force full re-enrichment. */
  full?: boolean;
  /** --review: show the narrative and confirm BEFORE writing. */
  review?: boolean;
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** --engine family pin. */
  engine?: string;
  /** Explicit adapter always wins (init's chosen harness, tests). */
  harness?: ExtractionHarness;
  harnesses?: ResolveEngineOptions["harnesses"];
  resolveCredential?: ResolveEngineOptions["resolveCredential"];
  computeDiff?: (options: ComputeDiffOptions) => Promise<EnrichmentDiff>;
  treeHash?: (root: string) => Promise<string | undefined>;
  appName?: string;
  onProgress?: (line: string) => void;
}

export type SyncEnrichmentResult =
  | { status: "enriched"; applied: number; clamped: number; stale: number; unenriched: number }
  | { status: "structural-only"; unenriched: number }
  | { status: "up-to-date" }
  | { status: "declined" }
  | { status: "skipped" };

export async function runSyncEnrichment(options: SyncEnrichmentOptions): Promise<SyncEnrichmentResult> {
  const file = await readToolsFile(options.vendoDir);
  // No (parseable) tools.json means the structural sync already failed soft
  // and said so — nothing to enrich, nothing to add.
  if (file === null) return { status: "skipped" };

  const previous = options.previous;
  const candidates = {
    // No previous state = first-ever enrichment: every tool is NEW (the
    // narrative must say so, not "changed").
    added: file.tools.filter((tool) => previous === null || !previous.srcHashes.has(tool.name)).map((tool) => tool.name),
    changed: file.tools.filter((tool) => {
      if (previous === null || !previous.srcHashes.has(tool.name)) return false;
      const before = previous.srcHashes.get(tool.name);
      return before !== undefined && tool.srcHash !== undefined && before !== tool.srcHash;
    }).map((tool) => tool.name),
    unenriched: file.tools.filter((tool) => tool.enriched !== true).map((tool) => tool.name),
  };

  // The up-to-date check runs BEFORE engine resolution: it is purely local
  // (git diff + candidate sets), so a fully enriched, unchanged catalog says
  // "up to date" whether or not a model key is around — and a keyed sync
  // never probes engine availability just to discover there is no work.
  const diff = await (options.computeDiff ?? computeEnrichmentDiff)({
    root: options.root,
    ...(previous?.watermark === undefined ? {} : { watermark: previous.watermark }),
    ...(options.full === true ? { full: true } : {}),
  });
  if (
    diff.mode === "diff" && diff.files.length === 0
    && candidates.added.length === 0 && candidates.changed.length === 0 && candidates.unenriched.length === 0
  ) {
    options.note("enrichment: up to date");
    return { status: "up-to-date" };
  }

  // Engine ladder — explicit harness (adapter rule: an explicitly passed
  // adapter always wins) → explicit pin → BYO env key → VENDO_API_KEY → none.
  let harness = options.harness;
  let credential = "explicit engine";
  if (harness === undefined) {
    const resolved = await resolveEnrichmentEngine({
      root: options.root,
      env: options.env,
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
      ...(options.resolveCredential === undefined ? {} : { resolveCredential: options.resolveCredential }),
    });
    if (resolved.engine === null) {
      // Keyless = today's behavior: structural-only sync, one calm line,
      // zero errors. Unenriched entries are already marked by the absence of
      // the per-tool `enriched` marker.
      options.note(
        `enrichment: structural-only (${resolved.reason ?? "no engine"}) — ${candidates.unenriched.length} tools unenriched`,
      );
      return { status: "structural-only", unenriched: candidates.unenriched.length };
    }
    harness = resolved.engine.harness;
    credential = resolved.engine.credential;
  }

  const overrides = await readOverridesContext(options.vendoDir);
  let appName = options.appName;
  if (appName === undefined) {
    try {
      appName = (JSON.parse((await readOptional(join(options.root, "package.json"))) ?? "{}") as { name?: string }).name ?? "app";
    } catch {
      appName = "app";
    }
  }

  const result = await runEnrichment({
    root: options.root,
    env: options.env,
    harness,
    appName,
    file,
    overrides,
    diff,
    candidates,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  if (!result.ok) {
    // Unparseable model output must never corrupt the file: warn + skip, the
    // structural sync stands, and the untouched watermark retries next run.
    options.warn(`warning: enrichment output unparseable — skipped, structural sync stands (${sanitize(result.error)})`);
    return { status: "skipped" };
  }

  const narrative = buildEnrichmentNarrative({ credential, outcome: result.outcome, candidates });
  if (options.review === true) {
    for (const line of narrative) options.note(line);
    const confirmed = await (options.confirm ?? (async () => true))("Apply this enrichment to .vendo/tools.json?", true);
    if (!confirmed) {
      options.note("enrichment declined — structural sync stands (watermark unchanged; re-run to retry)");
      return { status: "declined" };
    }
  }

  // Success advances the watermark to the current tree — the next sync diffs
  // from here. (HEAD tree: uncommitted edits re-enter the next diff until
  // committed, which re-reviews them at worst — never misses them.)
  const watermark = await (options.treeHash ?? gitTreeHash)(options.root);
  await writeToolsFile(options.vendoDir, result.outcome.file, watermark);
  if (options.review !== true) {
    for (const line of narrative) options.note(line);
  }
  return {
    status: "enriched",
    applied: result.outcome.applied.length,
    clamped: result.outcome.clamped.length,
    stale: result.outcome.stale.length,
    unenriched: result.outcome.unenriched.length,
  };
}

// ---------------------------------------------------------------------------
// init's degenerate full-repo pass: the staged extraction draft IS the
// proposal set (one engine, no second model spend) — it applies through the
// SAME clamp/marker/watermark machinery sync uses.
// ---------------------------------------------------------------------------

export interface DraftEnrichmentSummary {
  applied: number;
  clamped: string[];
  notes: string[];
  /** Tools still live once grades and overrides settle — zero is warned on. */
  enabledAfter: number;
}

export async function applyDraftEnrichment(input: {
  root: string;
  vendoDir: string;
  draft: Pick<ExtractionDraft, "tools">;
  treeHash?: (root: string) => Promise<string | undefined>;
}): Promise<DraftEnrichmentSummary | null> {
  const file = await readToolsFile(input.vendoDir);
  if (file === null) return null;
  const byName = new Map(file.tools.map((tool) => [tool.name, tool]));
  const clamped: string[] = [];
  const notes: string[] = [];
  let applied = 0;
  for (const entry of input.draft.tools) {
    const current = byName.get(entry.name);
    if (current === undefined) {
      notes.push(`enrichment: draft for unknown tool "${entry.name}" ignored`);
      continue;
    }
    const verdict = clampEnrichment(current, {
      description: entry.description,
      ...(entry.risk === undefined ? {} : { risk: entry.risk }),
      ...(entry.critical === undefined ? {} : { critical: entry.critical }),
      ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
      ...(entry.audience === undefined ? {} : { audience: entry.audience }),
    });
    clamped.push(...verdict.clamped);
    byName.set(entry.name, applyEnrichmentFields(current, verdict.fields));
    applied += 1;
  }
  const tools = file.tools.map((tool) => byName.get(tool.name) ?? tool);
  const watermark = await (input.treeHash ?? gitTreeHash)(input.root);
  await writeToolsFile(input.vendoDir, { ...file, tools }, watermark);

  const overrides = await readOverridesContext(input.vendoDir);
  const enabledAfter = mergeOverrides(tools, overrides).filter((tool) => tool.disabled !== true).length;
  return { applied, clamped, notes, enabledAfter };
}
