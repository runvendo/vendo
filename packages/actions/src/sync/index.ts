import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, descriptorHash, VendoError } from "@vendoai/core";
import {
  overridesFileSchema,
  toolsFileSchema,
  type BreakingChange,
  type ExtractedTool,
  type HttpMethod,
  type OverridesFile,
  type SyncReport,
  type ToolOverride,
  type ToolsFile,
} from "../formats.js";
import { dedupKey, routeToolFullName, withUniqueNames } from "./common.js";
import { extractOpenApi } from "./openapi.js";
import { capturePins } from "./pins.js";
import { scanRoutes } from "./route-scan.js";

export type SyncReportWithWarnings = SyncReport & { warnings: string[] };

export function hostToolName(method: HttpMethod, routePath: string): string {
  return withUniqueNames([{
    name: routeToolFullName(method, routePath),
    description: "",
    inputSchema: {},
    risk: "write",
    binding: { kind: "route", method, path: routePath, argsIn: "body" },
  }])[0]!.name;
}

function definedOverride(override: ToolOverride): ToolOverride {
  return Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  ) as ToolOverride;
}

export function mergeOverrides(tools: ExtractedTool[], overrides: OverridesFile | null): ExtractedTool[] {
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

async function firstOpenApiSpec(root: string): Promise<string | null> {
  const candidates = [
    "openapi.json",
    "openapi.yaml",
    "openapi.yml",
    path.join("public", "openapi.json"),
    path.join("docs", "openapi.json"),
    path.join("docs", "openapi.yaml"),
  ];
  for (const relative of candidates) {
    const candidate = path.join(root, relative);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // First existing file wins; absent candidates are expected.
    }
  }
  return null;
}

function bindingKey(tool: ExtractedTool): string {
  return dedupKey(tool.binding.method, tool.binding.path);
}

function unionExtracted(openApi: ExtractedTool[], routes: ExtractedTool[]): ExtractedTool[] {
  const seen = new Set<string>();
  const union: ExtractedTool[] = [];
  for (const tool of [...openApi, ...routes]) {
    const key = bindingKey(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(tool);
  }
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

function inputNarrowed(previous: ExtractedTool, next: ExtractedTool): boolean {
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
    if (!sameJson(oldProperty.type, newProperty.type)) return true;
    const oldEnum = arrayValue(oldProperty.enum);
    const newEnum = arrayValue(newProperty.enum);
    if (oldEnum.length > 0 && newEnum.length > 0) {
      const newValues = new Set(newEnum.map((value) => canonicalJson(value)));
      if (oldEnum.some((value) => !newValues.has(canonicalJson(value)))) return true;
    }
  }
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

async function writeIfChanged(file: string, bytes: string): Promise<void> {
  try {
    if (await fs.readFile(file, "utf8") === bytes) return;
  } catch {
    // A missing artifact is created below.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, "utf8");
}

export async function vendoSync(options: {
  root: string;
  out?: string;
  strict?: boolean;
}): Promise<SyncReportWithWarnings> {
  const root = path.resolve(options.root);
  const out = path.resolve(options.out ?? path.join(root, ".vendo"));
  const warnings: string[] = [];
  const toolsPath = path.join(out, "tools.json");
  const previousFile = await readPrevious(toolsPath, warnings);
  const overrides = await readOverrides(path.join(out, "overrides.json"));

  const specPath = await firstOpenApiSpec(root);
  const openApiTools = specPath ? await extractOpenApi(specPath) : [];
  const routeResult = await scanRoutes(root);
  warnings.push(...routeResult.warnings);
  const extracted = toolsFileSchema.parse({
    format: "vendo/tools@1",
    tools: unionExtracted(openApiTools, routeResult.tools),
  });

  const mergedPrevious = mergeOverrides(previousFile?.tools ?? [], overrides);
  const mergedNext = mergeOverrides(extracted.tools, overrides);
  const comparison = compareTools(mergedPrevious, mergedNext);

  await writeIfChanged(toolsPath, `${JSON.stringify(extracted, null, 2)}\n`);
  const pins = await capturePins(root, out);
  warnings.push(...pins.warnings);
  const report: SyncReportWithWarnings = {
    ...comparison,
    pins: { captured: pins.captured, drifted: pins.drifted },
    warnings,
  };
  if (options.strict && report.breaking.length > 0) {
    throw new VendoError("conflict", "breaking tool changes", { breaking: report.breaking, report });
  }
  return report;
}
