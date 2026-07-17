import { promises as fs } from "node:fs";
import path from "node:path";
import type TS from "typescript";
import type { ExtractedTool, TrpcBinding } from "../formats.js";
import {
  allocateToolName,
  resolveImportSource,
  trpcRisk,
  trpcToolFullName,
  walk,
} from "./common.js";
import {
  MAX_RESOLVE_DEPTH,
  PERMISSIVE_INPUT,
  calleeName,
  hasDependency,
  importMap,
  loadTypescript,
  parseModule,
  propertyKeyName,
  resolveIdentifier,
  zodFromExpression,
  type FileModule,
  type StaticExtraction,
} from "./static-ts.js";

/**
 * Static tRPC extraction (04 §1, additive within vendo/tools@1).
 *
 * Routers are parsed with the TypeScript compiler API — no code from the host
 * is executed. The compiler itself is resolved from the HOST's node_modules
 * (every tRPC app is a TypeScript app); when it cannot be resolved the
 * extractor fails closed to zero tools with a warning.
 *
 * Zod input schemas are statically interpreted into JSON Schema for common
 * patterns; unrecognized validators fail closed to a permissive schema with a
 * note on the tool.
 */

export interface TrpcExtractResult {
  tools: ExtractedTool[];
  warnings: string[];
}

const SOURCE_FILE_PATTERN = /\.(?:tsx?|jsx?)$/;
const ROUTER_FACTORY_NAMES = new Set(["router", "createTRPCRouter", "createRouter"]);
const MERGE_ROUTERS_NAMES = new Set(["mergeRouters"]);
const PROCEDURE_KINDS = new Set(["query", "mutation", "subscription"]);
const DEFAULT_MOUNT = "/api/trpc";

export async function detectTrpc(root: string): Promise<boolean> {
  return hasDependency(root, "@trpc/server");
}

interface ProcedureDef {
  kind: "procedure";
  type: "query" | "mutation" | "subscription" | "unknown";
  inputExpr?: TS.Expression;
  module: FileModule;
}

interface RouterDef {
  kind: "router";
  entries: Map<string, RouterDef | ProcedureDef>;
}

interface Extraction extends StaticExtraction {
  warnings: string[];
  routerFactorySources: Set<string>; // "importerFile\tspecifier" pairs the router factory was imported through
  /** Files contributing to the CURRENT mount's router graph — superjson
   * detection is scoped here so one mount's transformer never leaks onto
   * another mount's tools. */
  graphFiles: Set<string>;
}

/** Record where the router factory identifier was imported from, so the
 * superjson transformer can be detected in the initTRPC module. */
function recordRouterFactorySource(extraction: Extraction, module: FileModule, factoryName: string): void {
  const imported = importMap(extraction, module).get(factoryName);
  if (imported) extraction.routerFactorySources.add(`${module.file}\t${imported.specifier}`);
}

/** Is this call expression a procedure chain ending in .query/.mutation/.subscription? */
function procedureFromChain(extraction: Extraction, expr: TS.CallExpression, module: FileModule): ProcedureDef | null {
  const { ts } = extraction;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || !PROCEDURE_KINDS.has(callee.name.text)) return null;
  const type = callee.name.text as "query" | "mutation" | "subscription";
  let inputExpr: TS.Expression | undefined;
  // Walk down the chain collecting .input(...)
  let current: TS.Expression = callee.expression;
  while (ts.isCallExpression(current)) {
    const inner = current.expression;
    if (ts.isPropertyAccessExpression(inner)) {
      if (inner.name.text === "input" && current.arguments.length > 0 && inputExpr === undefined) {
        inputExpr = current.arguments[0]!;
      }
      current = inner.expression;
    } else {
      break;
    }
  }
  return { kind: "procedure", type, inputExpr, module };
}

async function evaluateRouterExpression(
  extraction: Extraction,
  module: FileModule,
  expr: TS.Expression,
  depth: number,
  contextPath: string,
): Promise<RouterDef | ProcedureDef | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const { ts } = extraction;
  extraction.graphFiles.add(module.file);

  if (ts.isIdentifier(expr)) {
    const resolved = await resolveIdentifier(extraction, module, expr.text, depth + 1);
    if (!resolved) return null;
    return evaluateRouterExpression(extraction, resolved.module, resolved.expr, depth + 1, contextPath);
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return evaluateRouterExpression(extraction, module, expr.expression, depth + 1, contextPath);
  }
  if (!ts.isCallExpression(expr)) return null;

  const name = calleeName(extraction, expr);
  if (name && MERGE_ROUTERS_NAMES.has(name)) {
    const entries = new Map<string, RouterDef | ProcedureDef>();
    for (const argument of expr.arguments) {
      const merged = await evaluateRouterExpression(extraction, module, argument, depth + 1, contextPath);
      if (merged?.kind === "router") {
        for (const [key, value] of merged.entries) entries.set(key, value);
      } else {
        extraction.warnings.push(`trpc: could not statically resolve a mergeRouters argument at ${contextPath || "<root>"}`);
      }
    }
    return { kind: "router", entries };
  }

  if (name && ROUTER_FACTORY_NAMES.has(name) && expr.arguments.length === 1) {
    const argument = expr.arguments[0]!;
    if (ts.isObjectLiteralExpression(argument)) {
      // For `t.router({...})` the factory source is the namespace base `t`
      // (the initTRPC instance), not the "router" method name; for a bare
      // `router({...})` it is the imported `router` identifier itself.
      const factoryName = ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)
        ? expr.expression.expression.text
        : ts.isIdentifier(expr.expression) ? expr.expression.text : name;
      recordRouterFactorySource(extraction, module, factoryName);
      const entries = new Map<string, RouterDef | ProcedureDef>();
      for (const property of argument.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = propertyKeyName(extraction, property.name);
          if (!key) continue;
          const child = await evaluateRouterEntry(extraction, module, property.initializer, depth + 1, `${contextPath}${contextPath ? "." : ""}${key}`);
          if (child) entries.set(key, child);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const key = property.name.text;
          const resolved = await resolveIdentifier(extraction, module, key, depth + 1);
          const child = resolved
            ? await evaluateRouterEntry(extraction, resolved.module, resolved.expr, depth + 1, `${contextPath}${contextPath ? "." : ""}${key}`)
            : null;
          if (child) entries.set(key, child);
          else extraction.warnings.push(`trpc: could not statically resolve router entry "${key}"`);
        } else if (ts.isSpreadAssignment(property)) {
          const spread = await evaluateRouterExpression(extraction, module, property.expression, depth + 1, contextPath);
          if (spread?.kind === "router") {
            for (const [key, value] of spread.entries) entries.set(key, value);
          } else {
            extraction.warnings.push(`trpc: could not statically resolve a spread router entry at ${contextPath || "<root>"}`);
          }
        }
      }
      return { kind: "router", entries };
    }
  }

  return procedureFromChain(extraction, expr, module);
}

async function evaluateRouterEntry(
  extraction: Extraction,
  module: FileModule,
  expr: TS.Expression,
  depth: number,
  contextPath: string,
): Promise<RouterDef | ProcedureDef | null> {
  const result = await evaluateRouterExpression(extraction, module, expr, depth, contextPath);
  if (result) return result;
  extraction.warnings.push(`trpc: could not statically classify router entry "${contextPath}"; it was skipped`);
  return null;
}

// ---------------------------------------------------------------------------
// Mount discovery
// ---------------------------------------------------------------------------

interface TrpcMount {
  file: string;
  mount: string;
  routerName: string | null;
  module: FileModule;
}

function isRouteFileCandidate(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const file = parts.at(-1) ?? "";
  if (/^route\.(?:tsx?|jsx?)$/.test(file) && parts.includes("app")) return true;
  const pagesIndex = parts.findIndex((part) => part === "pages");
  return pagesIndex !== -1 && parts[pagesIndex + 1] === "api" && SOURCE_FILE_PATTERN.test(file) && !/\.d\.ts$/.test(file);
}

function isDynamicSegment(segment: string): boolean {
  return /^\[.*\]$/.test(segment);
}

function mountPathFromFile(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const file = parts.at(-1) ?? "";
  if (/^route\.(?:tsx?|jsx?)$/.test(file)) {
    const appIndex = parts.findIndex((part) => part === "app");
    if (appIndex === -1) return null;
    const segments = parts.slice(appIndex + 1, -1)
      .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")) && !segment.startsWith("@"))
      .filter((segment) => !isDynamicSegment(segment));
    return `/${segments.join("/")}`.replace(/\/+/g, "/");
  }
  const pagesIndex = parts.findIndex((part) => part === "pages");
  if (pagesIndex === -1) return null;
  const fileBase = file.replace(/\.(?:tsx?|jsx?)$/, "");
  const segments = [...parts.slice(pagesIndex + 1, -1), fileBase]
    .filter((segment) => segment !== "index" && !isDynamicSegment(segment));
  return `/${segments.join("/")}`.replace(/\/+/g, "/");
}

function handlerOptions(extraction: Extraction, module: FileModule): { endpoint?: string; routerName: string | null } | null {
  const { ts } = extraction;
  let found: { endpoint?: string; routerName: string | null } | null = null;
  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const name = calleeName(extraction, node);
      if ((name === "fetchRequestHandler" || name === "createNextApiHandler") && node.arguments.length > 0) {
        const argument = node.arguments[0]!;
        if (ts.isObjectLiteralExpression(argument)) {
          let endpoint: string | undefined;
          let routerName: string | null = null;
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = propertyKeyName(extraction, property.name);
            if (key === "endpoint" && ts.isStringLiteral(property.initializer)) endpoint = property.initializer.text;
            if (key === "router" && ts.isIdentifier(property.initializer)) routerName = property.initializer.text;
          }
          found = { endpoint, routerName };
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sf);
  return found;
}

async function findMounts(extraction: Extraction): Promise<TrpcMount[]> {
  const files = await walk(extraction.root, isRouteFileCandidate);
  const mounts: TrpcMount[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("@trpc/server/adapters")) continue;
    const module = parseModule(extraction, file, source);
    const options = handlerOptions(extraction, module);
    if (!options) continue;
    const relativePath = path.relative(extraction.root, file);
    const rawMount = options.endpoint ?? mountPathFromFile(relativePath) ?? DEFAULT_MOUNT;
    // Normalize a trailing slash (an `endpoint: "/api/trpc/"` literal) so the
    // mount matches route-scan's `/api/trpc/{trpc}` shadowing and stays a
    // single identity; the root mount "/" is preserved.
    const mount = rawMount.length > 1 ? rawMount.replace(/\/+$/, "") : rawMount;
    mounts.push({ file, mount, routerName: options.routerName, module });
  }
  return mounts;
}

// ---------------------------------------------------------------------------
// Superjson detection
// ---------------------------------------------------------------------------

async function detectSuperjson(extraction: Extraction): Promise<boolean> {
  const transformerPattern = /transformer\s*:\s*(superjson|SuperJSON)/;
  // Scoped to the CURRENT mount's router graph — a plain-JSON mount must not
  // inherit another mount's superjson transformer.
  for (const file of extraction.graphFiles) {
    const module = extraction.modules.get(file);
    if (module && transformerPattern.test(module.source)) return true;
  }
  // The initTRPC module is usually NOT part of the router graph — resolve it
  // from wherever THIS graph's files imported the router factory.
  for (const entry of extraction.routerFactorySources) {
    const [importer, specifier] = entry.split("\t");
    if (!importer || !specifier || !extraction.graphFiles.has(importer)) continue;
    const resolved = await resolveImportSource(importer, specifier, extraction.root);
    if (resolved && transformerPattern.test(resolved.source)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extraction entry point
// ---------------------------------------------------------------------------

function flattenProcedures(router: RouterDef, prefix: string, out: Array<{ procedure: string; def: ProcedureDef }>): void {
  for (const [key, value] of router.entries) {
    const procedurePath = prefix ? `${prefix}.${key}` : key;
    if (value.kind === "router") flattenProcedures(value, procedurePath, out);
    else out.push({ procedure: procedurePath, def: value });
  }
}

export async function extractTrpc(root: string): Promise<TrpcExtractResult> {
  const warnings: string[] = [];
  const ts = loadTypescript(root);
  if (!ts) {
    return {
      tools: [],
      warnings: ["trpc extraction skipped: the TypeScript compiler could not be resolved from the host package"],
    };
  }
  const extraction: Extraction = {
    ts,
    root,
    modules: new Map(),
    warnings,
    routerFactorySources: new Set(),
    graphFiles: new Set(),
  };

  const mounts = await findMounts(extraction);
  if (mounts.length === 0) {
    return { tools: [], warnings: ["trpc detected (@trpc/server dependency) but no HTTP adapter mount was found; no trpc tools extracted"] };
  }

  const tools: ExtractedTool[] = [];
  const usedNames = new Set<string>();
  const seenProcedures = new Set<string>();

  for (const mount of mounts) {
    if (!mount.routerName) {
      warnings.push(`trpc mount ${mount.mount} does not reference a statically-resolvable router`);
      continue;
    }
    extraction.graphFiles = new Set([mount.file]);
    const resolved = await resolveIdentifier(extraction, mount.module, mount.routerName, 0);
    if (!resolved) {
      warnings.push(`trpc router "${mount.routerName}" for mount ${mount.mount} could not be statically resolved`);
      continue;
    }
    const router = await evaluateRouterExpression(extraction, resolved.module, resolved.expr, 0, "");
    if (!router || router.kind !== "router") {
      warnings.push(`trpc router "${mount.routerName}" for mount ${mount.mount} is not a statically-parsable router`);
      continue;
    }
    const transformer = (await detectSuperjson(extraction)) ? ("superjson" as const) : undefined;

    const procedures: Array<{ procedure: string; def: ProcedureDef }> = [];
    flattenProcedures(router, "", procedures);
    for (const { procedure, def } of procedures) {
      const dedup = `${mount.mount}\t${procedure}`;
      if (seenProcedures.has(dedup)) continue;
      seenProcedures.add(dedup);

      if (def.type === "subscription" || def.type === "unknown") {
        const name = allocateToolName(trpcToolFullName(procedure), "mutation", usedNames);
        const reason = def.type === "subscription"
          ? "tRPC subscriptions are not invokable over the HTTP envelope"
          : "procedure type could not be statically classified";
        tools.push({
          name,
          description: `tRPC procedure ${procedure} could not be classified`,
          inputSchema: { type: "object", properties: {} },
          risk: "destructive",
          disabled: true,
          note: `${reason}; enable only after review; overrides.json can flip disabled/risk`,
          binding: bindingFor(procedure, "mutation", mount.mount, transformer),
        });
        warnings.push(`trpc procedure ${procedure} could not be classified: ${reason}`);
        continue;
      }

      let inputSchema: Record<string, unknown> = { type: "object", properties: {} };
      let note: string | undefined;
      if (def.inputExpr) {
        const interpreted = await zodFromExpression(extraction, def.module, def.inputExpr, 0);
        if (interpreted.recognized) {
          inputSchema = interpreted.schema;
          if (interpreted.reason) note = `input schema partially interpreted; permissive where unknown (${interpreted.reason})`;
        } else {
          inputSchema = { ...PERMISSIVE_INPUT };
          note = `input schema not statically interpreted (${interpreted.reason ?? "unrecognized validator"}); permissive schema emitted`;
        }
      }

      const name = allocateToolName(trpcToolFullName(procedure), def.type, usedNames);
      tools.push({
        name,
        description: `tRPC ${def.type} ${procedure}`,
        inputSchema,
        risk: trpcRisk(def.type, procedure),
        ...(note ? { note } : {}),
        binding: bindingFor(procedure, def.type, mount.mount, transformer),
      });
    }
  }

  return { tools, warnings };
}

function bindingFor(
  procedure: string,
  type: "query" | "mutation",
  mount: string,
  transformer: "superjson" | undefined,
): TrpcBinding {
  return {
    kind: "trpc",
    procedure,
    type,
    mount,
    ...(transformer ? { transformer } : {}),
  };
}

/** The mounts trpc tools were extracted from — route-scan tools under these
 * paths are shadowed (the catch-all HTTP route is not a real API surface). */
export function trpcMounts(tools: readonly ExtractedTool[]): string[] {
  const mounts = new Set<string>();
  for (const tool of tools) {
    if (tool.binding.kind === "trpc") mounts.add(tool.binding.mount);
  }
  return [...mounts];
}
