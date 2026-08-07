import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, descriptorHash, VendoError, type JsonSchema, type ToolSemantics } from "@vendoai/core";
import {
  VENDO_TOOLS_FORMAT,
  overridesFileSchema,
  schemaIsBlind,
  toolsFileSchema,
  type BreakingChange,
  type ExtractedTool,
  type OverridesFile,
  type SyncReport,
  type ToolOverride,
  type ToolsFile,
} from "../formats.js";
import { bindingIdentity, clearAliasCache, withUniqueNames, writeIfChanged } from "./common.js";
import { compilerFloorWarning } from "./compiler-gate.js";
import { scanComponentCatalog } from "./catalog-scan.js";
import { writeCatalog } from "./catalog.js";
import { captureHostComponents } from "./components.js";
import { runExtractors } from "./extractors.js";
import { capturePins } from "./pins.js";

export type SyncReportWithWarnings = SyncReport & {
  warnings: string[];
  /** Loud `<Remixable>` wrapper errors ("file:line — message"). The CLI fails
   *  the run on them: a wrapper that cannot capture is a defended constraint,
   *  not a degradation. */
  remixableErrors: string[];
};

function definedOverride(override: ToolOverride): ToolOverride {
  return Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  ) as ToolOverride;
}

export function mergeOverrides(
  tools: ExtractedTool[],
  overrides: Pick<OverridesFile, "tools"> | null,
): ExtractedTool[] {
  if (!overrides) return tools.map((tool) => ({ ...tool }));
  return tools.map((tool) => {
    const override = overrides.tools[tool.name];
    return override ? { ...tool, ...definedOverride(override) } : { ...tool };
  });
}

async function readPrevious(file: string, warnings: string[]): Promise<ToolsFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null; // first sync — nothing to diff against
  }
  try {
    return toolsFileSchema.parse(JSON.parse(raw));
  } catch {
    warnings.push(`no parseable previous tools file at ${file}; treating this as the first sync`);
    return null;
  }
}

async function readOverrides(file: string): Promise<OverridesFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return overridesFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    const detail = error && typeof error === "object" && "issues" in error
      ? { file, issues: (error as { issues: unknown }).issues }
      : { file, error: error instanceof Error ? error.message : String(error) };
    throw new VendoError("validation", `malformed overrides file: ${file}`, detail);
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
  // The JUDGE'S FILL is not a narrowing. A tool whose input nobody could read
  // carried a fail-closed placeholder; the run that infers it replaces that
  // placeholder wholesale, which trips every rule below. Reporting that as
  // breaking makes `vendoSync({ strict: true })` THROW on the judge's own
  // work. Only inference is exempt: a blind input turning `declared` means the
  // host added a real validator, which IS a breaking change worth reporting.
  if (schemaIsBlind(previous.inputSchemaSource) && next.inputSchemaSource === "inferred") return false;

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

/** The previous machine layer + the authored layer of `.vendo/`. */
interface VendoDirState {
  previousTools: ExtractedTool[];
  overrides: OverridesFile | null;
}

async function loadVendoDir(out: string, warnings: string[]): Promise<VendoDirState> {
  const previous = await readPrevious(path.join(out, "tools.json"), warnings);
  const overrides = await readOverrides(path.join(out, "overrides.json"));
  return { previousTools: previous?.tools ?? [], overrides };
}

/** What survives a wholesale regeneration of the machine layer, keyed by tool
 *  name and gated on binding identity. */
interface CarriedFields {
  identity: string;
  semantics?: ToolSemantics;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

function schemaCoverage(tools: readonly ExtractedTool[]): SyncReport["toolSchemas"] {
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const tool of tools) {
    if (schemaIsBlind(tool.inputSchemaSource)) inputs.push(tool.name);
    if (schemaIsBlind(tool.outputSchemaSource)) outputs.push(tool.name);
  }
  return {
    total: tools.length,
    inputs: { known: tools.length - inputs.length, unknown: inputs.sort() },
    outputs: { known: tools.length - outputs.length, unknown: outputs.sort() },
  };
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
  const { previousTools, overrides } = await loadVendoDir(out, warnings);

  const extraction = await runExtractors(root);
  warnings.push(...extraction.warnings);
  const extractedTools = unionExtracted(extraction.tools);
  // Machine layer carry-over: per-tool field semantics and JUDGE-INFERRED
  // schemas persist across syncs. Keyed by name AND binding identity — a
  // same-named tool whose binding changed serves a different response, so its
  // stale hints drop. Only `inferred` schemas are carried: a declared/types
  // schema is re-derived by its extractor every run, and carrying one would
  // resurrect a schema the host's own spec just deleted.
  const carriedByName = new Map<string, CarriedFields>();
  for (const tool of previousTools) {
    const carried: CarriedFields = { identity: bindingIdentity(tool.binding) };
    if (tool.semantics !== undefined) carried.semantics = tool.semantics;
    if (tool.inputSchemaSource === "inferred") carried.inputSchema = tool.inputSchema;
    if (tool.outputSchemaSource === "inferred" && tool.outputSchema !== undefined) {
      carried.outputSchema = tool.outputSchema;
    }
    if (carried.semantics !== undefined || carried.inputSchema !== undefined || carried.outputSchema !== undefined) {
      carriedByName.set(tool.name, carried);
    }
  }
  const hashCache = new Map<string, string | undefined>();
  const tools: ExtractedTool[] = [];
  for (const { srcPath, ...tool } of extractedTools) {
    // A tool's source file is attached only where the extractor already knows
    // it (route module, server-action module, the OpenAPI spec) — omitted
    // otherwise, never traced.
    const source = srcPath ?? (tool.binding.kind === "server-action" ? tool.binding.module : undefined);
    const srcHash = source === undefined ? undefined : await sourceHash(root, source, hashCache);
    const carried = carriedByName.get(tool.name);
    const inherited = carried !== undefined && carried.identity === bindingIdentity(tool.binding) ? carried : undefined;
    // The extractor's own reading always wins; a carried value only fills a
    // slot this run left blind.
    const inputFill = schemaIsBlind(tool.inputSchemaSource) ? inherited?.inputSchema : undefined;
    const outputFill = tool.outputSchema === undefined ? inherited?.outputSchema : undefined;
    tools.push({
      ...tool,
      ...(srcHash === undefined ? {} : { srcHash }),
      ...(inherited?.semantics === undefined ? {} : { semantics: inherited.semantics }),
      ...(inputFill === undefined ? {} : { inputSchema: inputFill, inputSchemaSource: "inferred" as const }),
      ...(outputFill === undefined ? {} : { outputSchema: outputFill, outputSchemaSource: "inferred" as const }),
    });
  }
  const extracted = toolsFileSchema.parse({ format: VENDO_TOOLS_FORMAT, tools });
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
  const catalogScan = await scanComponentCatalog(root);
  warnings.push(...catalogScan.warnings);
  const catalog = await writeCatalog(out, catalogScan.entries);
  const pins = await capturePins(root, out, new Set(overrides?.remix?.ignoreSlots ?? []));
  warnings.push(...pins.warnings);
  // The host's OWN registered components, captured for real so the console's
  // gallery renders them instead of a grey labeled block. Shares the pin walk's
  // app-root stylesheets — one project, one set of root CSS.
  const components = await captureHostComponents({
    root,
    out,
    sites: catalogScan.sites,
    styles: pins.styles,
    catalog: catalog.entries,
    degraded: catalogScan.degraded,
  });
  warnings.push(...components.warnings);
  // One report-level warning when any loader rejected a too-old host compiler
  // (the per-extractor "skipped" lines say what degraded; this says why).
  const floorWarning = compilerFloorWarning();
  if (floorWarning !== null) warnings.push(floorWarning);
  const report: SyncReportWithWarnings = {
    ...comparison,
    toolSchemas: schemaCoverage(extracted.tools),
    pins: {
      captured: pins.captured,
      drifted: pins.drifted,
      ...(pins.pruned.length === 0 ? {} : { pruned: pins.pruned }),
    },
    remixableErrors: pins.errors,
    catalog: { discovered: catalogScan.discovered, registered: catalogScan.registered },
    components: {
      captured: components.captured,
      drifted: components.drifted,
      ...(components.pruned.length === 0 ? {} : { pruned: components.pruned }),
      ...(components.skipped.length === 0 ? {} : { skipped: components.skipped }),
      ...(components.withoutSamples.length === 0 ? {} : { withoutSamples: components.withoutSamples }),
    },
    warnings,
  };
  if (options.strict && report.breaking.length > 0) {
    throw new VendoError("conflict", "breaking tool changes", { breaking: report.breaking, report });
  }
  return report;
}
