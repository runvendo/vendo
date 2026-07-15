import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
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

type Ts = typeof TS;

export interface TrpcExtractResult {
  tools: ExtractedTool[];
  warnings: string[];
}

const SOURCE_FILE_PATTERN = /\.(?:tsx?|jsx?)$/;
const ROUTER_FACTORY_NAMES = new Set(["router", "createTRPCRouter", "createRouter"]);
const MERGE_ROUTERS_NAMES = new Set(["mergeRouters"]);
const PROCEDURE_KINDS = new Set(["query", "mutation", "subscription"]);
const MAX_RESOLVE_DEPTH = 16;
const DEFAULT_MOUNT = "/api/trpc";

/** Resolve the TypeScript compiler from the host package (fail-closed). The
 * fallback require targets our own devDependency so tests and monorepo dev
 * work without a host install. */
export function loadTypescript(root: string): Ts | null {
  const requireFrom = [path.join(root, "package.json"), import.meta.url];
  for (const base of requireFrom) {
    try {
      return createRequire(base)("typescript") as Ts;
    } catch {
      // Try the next resolution base.
    }
  }
  return null;
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function detectTrpc(root: string): Promise<boolean> {
  const pkg = await readPackageJson(root);
  if (!pkg) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && "@trpc/server" in (deps as Record<string, unknown>)) return true;
  }
  return false;
}

interface FileModule {
  file: string;
  source: string;
  sf: TS.SourceFile;
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

interface Extraction {
  ts: Ts;
  root: string;
  modules: Map<string, FileModule>;
  warnings: string[];
  routerFactorySources: Set<string>; // files the router factory was imported from
}

function parseModule(extraction: Extraction, file: string, source: string): FileModule {
  const cached = extraction.modules.get(file);
  if (cached) return cached;
  const { ts } = extraction;
  const scriptKind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const module = { file, source, sf };
  extraction.modules.set(file, module);
  return module;
}

async function loadModule(extraction: Extraction, file: string): Promise<FileModule | null> {
  const cached = extraction.modules.get(file);
  if (cached) return cached;
  try {
    return parseModule(extraction, file, await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** import local name → specifier, for one module. */
function importMap(extraction: Extraction, module: FileModule): Map<string, { specifier: string; imported: string }> {
  const { ts } = extraction;
  const imports = new Map<string, { specifier: string; imported: string }>();
  for (const statement of module.sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) imports.set(clause.name.text, { specifier, imported: "default" });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          specifier,
          imported: (element.propertyName ?? element.name).text,
        });
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, { specifier, imported: "*" });
    }
  }
  return imports;
}

/** Find a top-level declaration's initializer by name within a module. */
function localInitializer(extraction: Extraction, module: FileModule, name: string): TS.Expression | null {
  const { ts } = extraction;
  for (const statement of module.sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

/** Follow `export { x } from "./y"` and `export * from "./y"` chains. */
async function resolveExport(
  extraction: Extraction,
  module: FileModule,
  name: string,
  depth: number,
): Promise<{ module: FileModule; expr: TS.Expression } | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const { ts } = extraction;
  const local = localInitializer(extraction, module, name);
  if (local) return { module, expr: local };

  for (const statement of module.sf.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.exportClause;
    let exportedAs: string | null = null;
    if (clause && ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.name.text === name) exportedAs = (element.propertyName ?? element.name).text;
      }
      if (exportedAs === null) continue;
    } else if (clause) {
      continue; // namespace re-export
    } else {
      exportedAs = name; // export * — try the same name
    }
    const resolved = await resolveImportSource(module.file, statement.moduleSpecifier.text, extraction.root);
    if (!resolved) continue;
    const target = parseModule(extraction, resolved.file, resolved.source);
    const found = await resolveExport(extraction, target, exportedAs, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Resolve an identifier to its defining expression, following local
 * declarations and one-hop-per-level imports. */
async function resolveIdentifier(
  extraction: Extraction,
  module: FileModule,
  name: string,
  depth: number,
): Promise<{ module: FileModule; expr: TS.Expression } | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const local = localInitializer(extraction, module, name);
  if (local) return { module, expr: local };
  const imported = importMap(extraction, module).get(name);
  if (!imported || imported.imported === "*" || imported.imported === "default") return null;
  const resolved = await resolveImportSource(module.file, imported.specifier, extraction.root);
  if (!resolved) return null;
  const target = parseModule(extraction, resolved.file, resolved.source);
  return resolveExport(extraction, target, imported.imported, depth + 1);
}

function calleeName(extraction: Extraction, expr: TS.CallExpression): string | null {
  const { ts } = extraction;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function propertyKeyName(extraction: Extraction, name: TS.PropertyName): string | null {
  const { ts } = extraction;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
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
      recordRouterFactorySource(extraction, module, ts.isIdentifier(expr.expression) ? expr.expression.text : name);
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
// Zod → JSON Schema (static, fail-closed)
// ---------------------------------------------------------------------------

interface ZodSchemaResult {
  schema: Record<string, unknown>;
  optional: boolean;
  recognized: boolean;
  reason?: string;
}

const PERMISSIVE_INPUT: Record<string, unknown> = { type: "object", additionalProperties: true };

function unrecognized(reason: string): ZodSchemaResult {
  return { schema: {}, optional: false, recognized: false, reason };
}

function literalValue(extraction: Extraction, expr: TS.Expression): string | number | boolean | null | undefined {
  const { ts } = extraction;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
    return -Number(expr.operand.text);
  }
  return undefined;
}

const ZOD_PASSTHROUGH_MODIFIERS = new Set([
  "trim", "refine", "superRefine", "transform", "describe", "brand", "readonly",
  "regex", "startsWith", "endsWith", "includes", "toLowerCase", "toUpperCase",
  "catch", "passthrough", "strict", "strip", "positive", "nonnegative", "negative",
  "nonpositive", "finite", "safe", "step", "multipleOf", "length", "nonempty", "cuid", "cuid2", "ulid", "nanoid",
]);

async function zodFromExpression(
  extraction: Extraction,
  module: FileModule,
  expr: TS.Expression,
  depth: number,
): Promise<ZodSchemaResult> {
  if (depth > MAX_RESOLVE_DEPTH) return unrecognized("zod schema nesting exceeded the static interpretation depth");
  const { ts } = extraction;

  if (ts.isIdentifier(expr)) {
    const resolved = await resolveIdentifier(extraction, module, expr.text, depth + 1);
    if (!resolved) return unrecognized(`schema reference "${expr.text}" could not be statically resolved`);
    return zodFromExpression(extraction, resolved.module, resolved.expr, depth + 1);
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return zodFromExpression(extraction, module, expr.expression, depth + 1);
  }
  if (!ts.isCallExpression(expr)) return unrecognized("schema expression is not a zod call");

  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return unrecognized("schema call has no zod-shaped callee");
  const method = callee.name.text;
  const receiver = callee.expression;

  // Chained modifier on an inner zod expression: z.string().min(1).optional()
  if (ts.isCallExpression(receiver) || (ts.isPropertyAccessExpression(receiver) && !ts.isIdentifier(receiver.expression))) {
    const inner = await zodFromExpression(extraction, module, receiver, depth + 1);
    if (!inner.recognized) return inner;
    return applyZodModifier(extraction, module, inner, method, expr, depth);
  }

  // Base constructor: z.string(), z.coerce.number(), schemaHelpers.thing()
  if (ts.isIdentifier(receiver)) {
    return zodBase(extraction, module, method, expr, depth);
  }
  if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression)) {
    // z.coerce.number() — receiver is z.coerce
    if (receiver.name.text === "coerce") return zodBase(extraction, module, method, expr, depth);
    return unrecognized(`zod namespace "${receiver.name.text}" is not statically interpreted`);
  }
  return unrecognized("schema call shape is not statically interpreted");
}

async function zodBase(
  extraction: Extraction,
  module: FileModule,
  method: string,
  call: TS.CallExpression,
  depth: number,
): Promise<ZodSchemaResult> {
  const { ts } = extraction;
  const ok = (schema: Record<string, unknown>): ZodSchemaResult => ({ schema, optional: false, recognized: true });
  switch (method) {
    case "object": {
      const argument = call.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) return unrecognized("z.object argument is not an object literal");
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const reasons: string[] = [];
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyKeyName(extraction, property.name);
        if (!key) continue;
        const value = await zodFromExpression(extraction, module, property.initializer, depth + 1);
        properties[key] = value.recognized ? value.schema : {};
        if (!value.recognized && value.reason) reasons.push(`${key}: ${value.reason}`);
        if (!value.optional && value.recognized) required.push(key);
      }
      const schema: Record<string, unknown> = {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
      if (reasons.length > 0) {
        // Partially recognized: emit what we know, keep unknown properties permissive.
        return { schema, optional: false, recognized: true, reason: reasons.join("; ") };
      }
      return ok(schema);
    }
    case "string": return ok({ type: "string" });
    case "number": return ok({ type: "number" });
    case "bigint": return ok({ type: "integer" });
    case "boolean": return ok({ type: "boolean" });
    case "date": return ok({ type: "string", format: "date-time" });
    case "null": return ok({ type: "null" });
    case "any":
    case "unknown": return ok({});
    case "void":
    case "undefined": return { schema: {}, optional: true, recognized: true };
    case "literal": {
      const value = call.arguments[0] ? literalValue(extraction, call.arguments[0]) : undefined;
      if (value === undefined) return unrecognized("z.literal value is not a static literal");
      return ok({ const: value });
    }
    case "enum": {
      const argument = call.arguments[0];
      if (!argument || !ts.isArrayLiteralExpression(argument)) return unrecognized("z.enum argument is not an array literal");
      const values: string[] = [];
      for (const element of argument.elements) {
        const value = literalValue(extraction, element);
        if (typeof value !== "string") return unrecognized("z.enum contains a non-literal value");
        values.push(value);
      }
      return ok({ type: "string", enum: values });
    }
    case "array": {
      const argument = call.arguments[0];
      if (!argument) return ok({ type: "array" });
      const items = await zodFromExpression(extraction, module, argument, depth + 1);
      return items.recognized
        ? ok({ type: "array", items: items.schema })
        : { schema: { type: "array" }, optional: false, recognized: true, reason: items.reason };
    }
    case "union":
    case "discriminatedUnion": {
      const argument = call.arguments[method === "union" ? 0 : 1];
      if (!argument || !ts.isArrayLiteralExpression(argument)) return unrecognized(`z.${method} options are not an array literal`);
      const options: Record<string, unknown>[] = [];
      for (const element of argument.elements) {
        const option = await zodFromExpression(extraction, module, element, depth + 1);
        if (!option.recognized) return unrecognized(option.reason ?? `z.${method} option not statically interpreted`);
        options.push(option.schema);
      }
      return ok({ anyOf: options });
    }
    case "record": {
      const valueArgument = call.arguments[call.arguments.length - 1];
      if (!valueArgument) return ok({ type: "object", additionalProperties: true });
      const value = await zodFromExpression(extraction, module, valueArgument, depth + 1);
      return ok({ type: "object", additionalProperties: value.recognized ? value.schema : true });
    }
    default:
      return unrecognized(`z.${method} is not statically interpreted`);
  }
}

async function applyZodModifier(
  extraction: Extraction,
  module: FileModule,
  inner: ZodSchemaResult,
  method: string,
  call: TS.CallExpression,
  depth: number,
): Promise<ZodSchemaResult> {
  const { ts } = extraction;
  void module;
  void depth;
  switch (method) {
    case "optional": return { ...inner, optional: true };
    case "nullish": return { ...inner, optional: true, schema: nullable(inner.schema) };
    case "nullable": return { ...inner, schema: nullable(inner.schema) };
    case "default": {
      const value = call.arguments[0] ? literalValue(extraction, call.arguments[0]) : undefined;
      return {
        ...inner,
        optional: true,
        schema: value !== undefined ? { ...inner.schema, default: value } : inner.schema,
      };
    }
    case "min": {
      const value = call.arguments[0] && ts.isNumericLiteral(call.arguments[0]) ? Number(call.arguments[0].text) : undefined;
      if (value === undefined) return inner;
      if (inner.schema.type === "string") return { ...inner, schema: { ...inner.schema, minLength: value } };
      if (inner.schema.type === "number" || inner.schema.type === "integer") return { ...inner, schema: { ...inner.schema, minimum: value } };
      if (inner.schema.type === "array") return { ...inner, schema: { ...inner.schema, minItems: value } };
      return inner;
    }
    case "max": {
      const value = call.arguments[0] && ts.isNumericLiteral(call.arguments[0]) ? Number(call.arguments[0].text) : undefined;
      if (value === undefined) return inner;
      if (inner.schema.type === "string") return { ...inner, schema: { ...inner.schema, maxLength: value } };
      if (inner.schema.type === "number" || inner.schema.type === "integer") return { ...inner, schema: { ...inner.schema, maximum: value } };
      if (inner.schema.type === "array") return { ...inner, schema: { ...inner.schema, maxItems: value } };
      return inner;
    }
    case "int": return { ...inner, schema: { ...inner.schema, type: "integer" } };
    case "email": return { ...inner, schema: { ...inner.schema, format: "email" } };
    case "uuid": return { ...inner, schema: { ...inner.schema, format: "uuid" } };
    case "url": return { ...inner, schema: { ...inner.schema, format: "uri" } };
    case "datetime": return { ...inner, schema: { ...inner.schema, format: "date-time" } };
    default:
      if (ZOD_PASSTHROUGH_MODIFIERS.has(method)) return inner;
      // Fail closed on modifiers we do not understand: keep the wire type
      // unknown rather than risk a wrong constraint.
      return unrecognized(`zod modifier .${method}() is not statically interpreted`);
  }
}

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(schema).length === 0 ? {} : { anyOf: [schema, { type: "null" }] };
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
    const mount = options.endpoint ?? mountPathFromFile(relativePath) ?? DEFAULT_MOUNT;
    mounts.push({ file, mount, routerName: options.routerName, module });
  }
  return mounts;
}

// ---------------------------------------------------------------------------
// Superjson detection
// ---------------------------------------------------------------------------

async function detectSuperjson(extraction: Extraction): Promise<boolean> {
  const transformerPattern = /transformer\s*:\s*(superjson|SuperJSON)/;
  for (const module of extraction.modules.values()) {
    if (transformerPattern.test(module.source)) return true;
  }
  // The initTRPC module is usually NOT part of the router graph — resolve it
  // from wherever the router factory was imported.
  for (const entry of extraction.routerFactorySources) {
    const [importer, specifier] = entry.split("\t");
    if (!importer || !specifier) continue;
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
  const extraction: Extraction = { ts, root, modules: new Map(), warnings, routerFactorySources: new Set() };

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
