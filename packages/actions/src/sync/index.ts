import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, descriptorHash, semanticsFileSchema, VendoError, type DomainManifest, type SemanticsFile, type ToolSemantics } from "@vendoai/core";
import {
  VENDO_OVERRIDES_FORMAT_V3,
  VENDO_TOOLS_FORMAT_V3,
  capabilitiesFileSchema,
  overridesFileSchema,
  overridesFileV3Schema,
  toolsFileSchema,
  toolsFileV3Schema,
  vendoFileVersion,
  type BreakingChange,
  type CapabilitiesFile,
  type ExtractedTool,
  type ExtractedToolV3,
  type OverridesFile,
  type OverridesFileV3,
  type SyncReport,
  type ToolOverride,
  type ToolsFile,
  type ToolsFileV3,
  type UnresolvedPin,
} from "../formats.js";
import { migrateLegacyVendoDir } from "../migrate.js";
import { bindingIdentity, clearAliasCache, withUniqueNames, writeIfChanged, type SourcedExtractedTool } from "./common.js";
import { withGeneratedDescriptions } from "./describe.js";
import { deriveDomains } from "./domains.js";
import { scanComponentCatalog } from "./catalog-scan.js";
import { writeCatalog } from "./catalog.js";
import { runExtractors } from "./extractors.js";
import { capturePins } from "./pins.js";
import { gitTreeHash } from "./watermark.js";

export type SyncReportWithWarnings = SyncReport & {
  warnings: string[];
  unresolvedPins: UnresolvedPin[];
  /** Present exactly once: the run that rewrote a legacy `.vendo/` layout into
   *  the v3 two-file pair — one printable paragraph describing the fold. */
  migrated?: string;
};

function definedOverride(override: ToolOverride): ToolOverride {
  return Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  ) as ToolOverride;
}

export function mergeOverrides(
  tools: ExtractedTool[],
  overrides: Pick<OverridesFile | OverridesFileV3, "tools"> | null,
): ExtractedTool[] {
  if (!overrides) return tools.map((tool) => ({ ...tool }));
  return tools.map((tool) => {
    const override = overrides.tools[tool.name];
    return override ? { ...tool, ...definedOverride(override) } : { ...tool };
  });
}

async function readPrevious(file: string, warnings: string[]): Promise<ToolsFile | ToolsFileV3 | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null; // first sync — nothing to diff against
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return vendoFileVersion(parsed) === 1 ? toolsFileSchema.parse(parsed) : toolsFileV3Schema.parse(parsed);
  } catch {
    warnings.push(`no parseable previous tools file at ${file}; treating this as the first sync`);
    return null;
  }
}

async function readOverrides(file: string): Promise<OverridesFile | OverridesFileV3 | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return vendoFileVersion(parsed) === 1 ? overridesFileSchema.parse(parsed) : overridesFileV3Schema.parse(parsed);
  } catch (error) {
    const detail = error && typeof error === "object" && "issues" in error
      ? { file, issues: (error as { issues: unknown }).issues }
      : { file, error: error instanceof Error ? error.message : String(error) };
    throw new VendoError("validation", `malformed overrides file: ${file}`, detail);
  }
}

async function readRetiredCapabilities(file: string): Promise<CapabilitiesFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return capabilitiesFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    const detail = error && typeof error === "object" && "issues" in error
      ? { file, issues: (error as { issues: unknown }).issues }
      : { file, error: error instanceof Error ? error.message : String(error) };
    // Fail loud: this file carries authored compounds/briefs the migration
    // must preserve — silently skipping it would drop them on the fold.
    throw new VendoError("validation", `malformed capabilities file: ${file}`, detail);
  }
}

async function readRetiredSemantics(file: string, warnings: string[]): Promise<{ present: boolean; parsed: SemanticsFile | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { present: false, parsed: null };
  }
  try {
    return { present: true, parsed: semanticsFileSchema.parse(JSON.parse(raw)) };
  } catch {
    warnings.push(`malformed retired file ${file}; its content was not migrated and the file was left in place for review`);
    return { present: true, parsed: null };
  }
}

function bindingKey(tool: ExtractedTool): string {
  return bindingIdentity(tool.binding);
}

function unionExtracted<T extends ExtractedTool>(extracted: T[]): T[] {
  const seen = new Set<string>();
  const union: T[] = [];
  for (const tool of extracted) {
    const key = bindingKey(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(tool);
  }
  union.sort((left, right) => left.name.localeCompare(right.name) || bindingKey(left).localeCompare(bindingKey(right)));
  return withUniqueNames(union).sort((left, right) => left.name.localeCompare(right.name));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function typeNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((entry): entry is string => typeof entry === "string");
}

export function inputNarrowed(previous: ExtractedTool, next: ExtractedTool): boolean {
  const oldSchema = objectValue(previous.inputSchema);
  const newSchema = objectValue(next.inputSchema);
  const oldRequired = new Set(arrayValue(oldSchema.required).filter((value): value is string => typeof value === "string"));
  const newRequired = arrayValue(newSchema.required).filter((value): value is string => typeof value === "string");
  if (newRequired.some((name) => !oldRequired.has(name))) return true;

  const oldProperties = objectValue(oldSchema.properties);
  const newProperties = objectValue(newSchema.properties);
  for (const [name, oldRawProperty] of Object.entries(oldProperties)) {
    if (!Object.prototype.hasOwnProperty.call(newProperties, name)) return true;
    const oldProperty = objectValue(oldRawProperty);
    const newProperty = objectValue(newProperties[name]);
    // Type changes are narrowing only when the new type set drops an old type
    // (mirrors the enum logic below: widenings are backward-compatible).
    const oldTypes = typeNames(oldProperty.type);
    const newTypes = typeNames(newProperty.type);
    if (oldTypes.length === 0 && newTypes.length > 0) return true;
    if (oldTypes.length > 0 && newTypes.length > 0) {
      const newTypeSet = new Set(newTypes);
      if (oldTypes.some((name) => !newTypeSet.has(name))) return true;
    }
    const oldEnum = arrayValue(oldProperty.enum);
    const newEnum = arrayValue(newProperty.enum);
    if (oldEnum.length === 0 && newEnum.length > 0) return true;
    if (oldEnum.length > 0 && newEnum.length > 0) {
      const newValues = new Set(newEnum.map((value) => canonicalJson(value)));
      if (oldEnum.some((value) => !newValues.has(canonicalJson(value)))) return true;
    }
  }
  if ((oldSchema.additionalProperties === undefined || oldSchema.additionalProperties === true)
      && newSchema.additionalProperties === false) return true;
  return false;
}

function compareTools(previous: ExtractedTool[], next: ExtractedTool[]): Pick<SyncReport, "tools" | "breaking"> {
  const oldByName = new Map(previous.map((tool) => [tool.name, tool]));
  const newByName = new Map(next.map((tool) => [tool.name, tool]));
  const added = [...newByName.keys()].filter((name) => !oldByName.has(name)).sort();
  const removed = [...oldByName.keys()].filter((name) => !newByName.has(name)).sort();
  const changed: string[] = [];
  const breaking: BreakingChange[] = [];

  for (const [name, oldTool] of oldByName) {
    const newTool = newByName.get(name);
    if (!newTool) continue;
    if (descriptorHash(oldTool) !== descriptorHash(newTool) || !sameJson(oldTool.binding, newTool.binding)) {
      changed.push(name);
    }
    if (bindingKey(oldTool) !== bindingKey(newTool)) breaking.push({ tool: name, change: "removed" });
    if (inputNarrowed(oldTool, newTool)) breaking.push({ tool: name, change: "input-narrowed" });
  }

  const addedByBinding = new Map(
    added.map((name) => {
      const tool = newByName.get(name)!;
      return [bindingKey(tool), tool] as const;
    }),
  );
  for (const name of removed) {
    const oldTool = oldByName.get(name)!;
    breaking.push({
      tool: name,
      change: addedByBinding.has(bindingKey(oldTool)) ? "renamed" : "removed",
    });
  }
  changed.sort();
  breaking.sort((left, right) => left.tool.localeCompare(right.tool) || left.change.localeCompare(right.change));
  return { tools: { added, removed, changed }, breaking };
}

/** `sha256:<hex>` of one extraction source file; undefined when unreadable.
 *  Line endings normalize to LF before hashing so a CRLF checkout (Windows
 *  autocrlf) and an LF checkout of the same source agree on the hash —
 *  committed tools.json must not churn across platforms. */
async function sourceHash(root: string, srcPath: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  if (!cache.has(srcPath)) {
    try {
      const text = await fs.readFile(path.resolve(root, srcPath), "utf8");
      cache.set(srcPath, `sha256:${createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`);
    } catch {
      cache.set(srcPath, undefined);
    }
  }
  return cache.get(srcPath);
}

/** The previous machine layer + the authored layer, normalized to v3 — a
 *  legacy dir (any of tools@1 / overrides@1 / capabilities.json /
 *  semantics.json) folds through `migrateLegacyVendoDir` and records the
 *  on-disk migration this sync must perform. */
interface VendoDirState {
  previousTools: Array<ExtractedTool | ExtractedToolV3>;
  previousDomains?: DomainManifest;
  overrides: OverridesFileV3 | null;
  migration?: {
    /** overrides.json needs rewriting in the v3 format (fold result). */
    writeOverrides: boolean;
    /** Retired files whose content now lives in the pair. */
    deletions: string[];
    summary: string;
  };
}

async function loadVendoDir(out: string, warnings: string[]): Promise<VendoDirState> {
  const previousFile = await readPrevious(path.join(out, "tools.json"), warnings);
  const overridesFile = await readOverrides(path.join(out, "overrides.json"));
  const capabilitiesPath = path.join(out, "capabilities.json");
  const capabilities = await readRetiredCapabilities(capabilitiesPath);
  const semanticsPath = path.join(out, "semantics.json");
  const semantics = await readRetiredSemantics(semanticsPath, warnings);

  const toolsV3 = previousFile !== null && previousFile.format === VENDO_TOOLS_FORMAT_V3 ? previousFile : undefined;
  const toolsV1 = previousFile !== null && previousFile.format !== VENDO_TOOLS_FORMAT_V3 ? previousFile : undefined;
  const overridesV3 = overridesFile !== null && overridesFile.format === VENDO_OVERRIDES_FORMAT_V3 ? overridesFile : undefined;
  const overridesV1 = overridesFile !== null && overridesFile.format !== VENDO_OVERRIDES_FORMAT_V3 ? overridesFile : undefined;

  // The pure fold (format v3): legacy files — any subset — become the pair.
  // A stale semantics.json next to an already-v3 tools.json is ignored (its
  // content was ingested when the dir was rewritten) and only deleted.
  const migrated = migrateLegacyVendoDir({
    ...(toolsV1 === undefined ? {} : { tools: toolsV1 }),
    ...(overridesV1 === undefined ? {} : { overrides: overridesV1 }),
    ...(capabilities === null ? {} : { capabilities }),
    ...(semantics.parsed === null || toolsV3 !== undefined ? {} : { semantics: semantics.parsed }),
  });

  // Authored layer: an already-v3 overrides.json wins; a retired
  // capabilities.json folds its compounds/briefs into whichever is current.
  // The legacy fold already ingested capabilities.json (compounds/briefs) —
  // only an ALREADY-v3 overrides.json needs the explicit fold-if-absent, and
  // only there can a genuine conflict exist (both files carrying entries).
  let overrides = overridesV3
    ?? (overridesV1 !== undefined || capabilities !== null ? migrated.overrides : null);
  let capabilitiesConflict = false;
  let foldedCompounds = capabilities !== null && overridesV3 === undefined && capabilities.tools.length > 0;
  let foldedBriefs = capabilities !== null && overridesV3 === undefined && (capabilities.briefs?.length ?? 0) > 0;
  if (capabilities !== null && overridesV3 !== undefined) {
    foldedCompounds = overridesV3.compounds === undefined && capabilities.tools.length > 0;
    foldedBriefs = overridesV3.briefs === undefined && (capabilities.briefs?.length ?? 0) > 0;
    overrides = {
      ...overridesV3,
      ...(foldedCompounds ? { compounds: capabilities.tools } : {}),
      ...(foldedBriefs ? { briefs: capabilities.briefs } : {}),
    };
    capabilitiesConflict = (overridesV3.compounds !== undefined && capabilities.tools.length > 0)
      || (overridesV3.briefs !== undefined && (capabilities.briefs?.length ?? 0) > 0);
    if (capabilitiesConflict) {
      warnings.push(
        `${capabilitiesPath} and overrides.json both carry compounds/briefs — overrides.json wins; entries unique to capabilities.json were not folded, so the file was left on disk for review (delete it yourself once reconciled)`,
      );
    }
  }

  // A malformed semantics.json is warned about and LEFT IN PLACE whatever its
  // neighbors look like — deleting a file whose content could not be read
  // would silently drop possible host edits, and it must never be a migration
  // trigger on its own (that would re-announce on every sync). Only a file
  // that parsed retires: folded into tools.json on the legacy path, or stale
  // (already ingested at the v3 rewrite) next to a v3 tools.json.
  const semanticsRetires = semantics.parsed !== null;
  const legacyPieces = [
    ...(toolsV1 !== undefined ? ["tools.json (vendo/tools@1)"] : []),
    ...(overridesV1 !== undefined ? ["overrides.json (vendo/overrides@1)"] : []),
    ...(capabilities !== null ? ["capabilities.json"] : []),
    ...(semanticsRetires ? ["semantics.json"] : []),
  ];
  const state: VendoDirState = {
    previousTools: toolsV3?.tools ?? migrated.tools.tools,
    ...(toolsV3?.domains !== undefined || migrated.tools.domains !== undefined
      ? { previousDomains: toolsV3?.domains ?? migrated.tools.domains }
      : {}),
    overrides,
  };
  if (legacyPieces.length === 0) return state;

  const deletions = [
    // A conflicted capabilities.json (entries unique to it were not folded)
    // stays on disk for review — deletion would silently drop authored work.
    ...(capabilities !== null && !capabilitiesConflict ? [capabilitiesPath] : []),
    // A parsed or stale semantics.json is retired — its content lives in
    // tools.json now (a malformed one stayed on disk, warned above).
    ...(semanticsRetires ? [semanticsPath] : []),
  ];
  // The summary describes only what THIS fold actually did. In the conflicted
  // state (capabilities.json left on disk for review) the dir still holds a
  // legacy file, so the migration re-announces on every sync alongside the
  // conflict warning — intentional nagging until the human reconciles.
  const semanticsFolded = semanticsRetires && toolsV3 === undefined;
  const foldedFromCapabilities = [
    ...(foldedCompounds ? ["compounds"] : []),
    ...(foldedBriefs ? ["briefs"] : []),
  ];
  const summary =
    `Migrated .vendo/ (legacy ${legacyPieces.join(", ")}) to the v3 two-file layout: `
    + `tools.json is now ${VENDO_TOOLS_FORMAT_V3} — the machine layer sync regenerates wholesale (extracted tools`
    + `${semanticsFolded ? " with inferred field semantics folded in from semantics.json" : ""}, the domain manifest, `
    + `per-tool source hashes, and the sync watermark) — and overrides.json is ${VENDO_OVERRIDES_FORMAT_V3}, the only `
    + "hand-edited file"
    + `${foldedFromCapabilities.length > 0 ? `, now also carrying the ${foldedFromCapabilities.join(" and ")} that lived in capabilities.json` : ""}. `
    + `${deletions.length > 0 ? `The retired ${deletions.map((file) => path.basename(file)).join(" and ")} ${deletions.length === 1 ? "was" : "were"} deleted — its content lives in the pair. ` : ""}`
    + "Every authored value (overrides, compounds, briefs, manual semantics corrections) was preserved; "
    + "review with `git diff .vendo` and commit the result.";
  state.migration = {
    writeOverrides: overrides !== null && (overridesV1 !== undefined || capabilities !== null),
    deletions,
    summary,
  };
  return state;
}

export async function vendoSync(options: {
  root: string;
  out?: string;
  strict?: boolean;
}): Promise<SyncReportWithWarnings> {
  const root = path.resolve(options.root);
  const out = path.resolve(options.out ?? path.join(root, ".vendo"));
  clearAliasCache(); // same-process re-runs (watch mode) must see tsconfig edits
  const warnings: string[] = [];
  const toolsPath = path.join(out, "tools.json");
  const { previousTools, previousDomains, overrides, migration } = await loadVendoDir(out, warnings);

  // On-disk legacy migration (format v3): write the authored half of the pair
  // and retire capabilities.json/semantics.json before anything else — the
  // machine half is written below by the ordinary (regenerating) path.
  if (migration !== undefined) {
    if (migration.writeOverrides && overrides !== null) {
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(
        path.join(out, "overrides.json"),
        `${JSON.stringify(overridesFileV3Schema.parse(overrides), null, 2)}\n`,
        "utf8",
      );
    }
  }

  const extraction = await runExtractors(root);
  warnings.push(...extraction.warnings);
  // W3 — empty descriptions get a deterministic "use this when…" line
  // (reviewable here, overridable forever via overrides.json).
  const described = withGeneratedDescriptions(unionExtracted(extraction.tools));
  // Machine layer carry-over: per-tool inferred semantics persist across syncs
  // (inference runs once — the CLI's dev-server pass fills gaps), and the
  // domain manifest is derived from tool names on FIRST sync only. A carried
  // entry is keyed by name AND binding identity: a same-named tool whose
  // binding changed serves a different response, so its stale shape hints
  // drop and the next dev-server pass re-infers.
  const semanticsByName = new Map<string, { semantics: ToolSemantics; identity: string }>();
  for (const tool of previousTools) {
    const semantics = (tool as ExtractedToolV3).semantics;
    if (semantics !== undefined) semanticsByName.set(tool.name, { semantics, identity: bindingIdentity(tool.binding) });
  }
  const hashCache = new Map<string, string | undefined>();
  const tools: ExtractedToolV3[] = [];
  for (const { srcPath, ...tool } of described) {
    // A tool's source file is attached only where the extractor already knows
    // it (route module, server-action module, the OpenAPI spec) — omitted
    // otherwise, never traced.
    const source = srcPath ?? (tool.binding.kind === "server-action" ? tool.binding.module : undefined);
    const srcHash = source === undefined ? undefined : await sourceHash(root, source, hashCache);
    const carried = semanticsByName.get(tool.name);
    const semantics = carried !== undefined && carried.identity === bindingIdentity(tool.binding)
      ? carried.semantics
      : undefined;
    tools.push({
      ...tool,
      ...(srcHash === undefined ? {} : { srcHash }),
      ...(semantics === undefined ? {} : { semantics }),
    });
  }
  const watermark = await gitTreeHash(root);
  const extracted = toolsFileV3Schema.parse({
    format: VENDO_TOOLS_FORMAT_V3,
    tools,
    ...(watermark === undefined ? {} : { watermark }),
    domains: previousDomains ?? { has: deriveDomains(tools.map((tool) => tool.name)), hasNot: [] },
  });
  if (overrides) {
    const extractedNames = new Set(extracted.tools.map((tool) => tool.name));
    for (const name of Object.keys(overrides.tools).sort()) {
      if (name.startsWith("host_") && !extractedNames.has(name)) {
        warnings.push(`host override ${name} did not match any extracted tool`);
      }
    }
  }

  const mergedPrevious = mergeOverrides(previousTools, overrides);
  const mergedNext = mergeOverrides(extracted.tools, overrides);
  const comparison = compareTools(mergedPrevious, mergedNext);

  await writeIfChanged(toolsPath, `${JSON.stringify(extracted, null, 2)}\n`);
  // Retire the legacy capabilities.json/semantics.json pair only after the new
  // tools.json is durably written — a mid-migration extraction failure above
  // would otherwise delete the old semantics before the folded replacement
  // exists on disk, losing inferred semantics/domains (Greptile P1 #552).
  if (migration !== undefined) {
    for (const file of migration.deletions) await fs.rm(file, { force: true });
  }
  const catalogScan = await scanComponentCatalog(root);
  warnings.push(...catalogScan.warnings);
  await writeCatalog(out, catalogScan.entries);
  const pins = await capturePins(root, out, new Set(overrides?.remix?.ignoreSlots ?? []));
  warnings.push(...pins.warnings);
  const report: SyncReportWithWarnings = {
    ...comparison,
    pins: { captured: pins.captured, drifted: pins.drifted },
    unresolvedPins: pins.unresolved,
    catalog: { discovered: catalogScan.discovered, registered: catalogScan.registered },
    warnings,
    ...(migration === undefined ? {} : { migrated: migration.summary }),
  };
  if (options.strict && report.breaking.length > 0) {
    throw new VendoError("conflict", "breaking tool changes", { breaking: report.breaking, report });
  }
  return report;
}
