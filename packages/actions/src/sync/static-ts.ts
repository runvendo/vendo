import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type TS from "typescript";
import { resolveImportSource } from "./common.js";

/**
 * Shared static TypeScript-source machinery for the compiler-API extractors
 * (tRPC, server actions): host-resolved compiler loading, module parsing,
 * identifier/export resolution across files, and the fail-closed static
 * zod → JSON Schema interpreter (04 §1). No host code is ever executed.
 */

export type Ts = typeof TS;

export const MAX_RESOLVE_DEPTH = 16;

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

export async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when any dependency field of the host package declares `name`. */
export async function hasDependency(root: string, name: string): Promise<boolean> {
  const pkg = await readPackageJson(root);
  if (!pkg) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && name in (deps as Record<string, unknown>)) return true;
  }
  return false;
}

export interface FileModule {
  file: string;
  source: string;
  sf: TS.SourceFile;
}

/** The shared state a static extraction threads through resolution. Extractors
 * may extend it with their own fields (structural typing keeps them compatible). */
export interface StaticExtraction {
  ts: Ts;
  root: string;
  modules: Map<string, FileModule>;
}

export function parseModule(extraction: StaticExtraction, file: string, source: string): FileModule {
  const cached = extraction.modules.get(file);
  if (cached) return cached;
  const { ts } = extraction;
  const scriptKind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const module = { file, source, sf };
  extraction.modules.set(file, module);
  return module;
}

/** import local name → specifier, for one module. */
export function importMap(extraction: StaticExtraction, module: FileModule): Map<string, { specifier: string; imported: string }> {
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
export function localInitializer(extraction: StaticExtraction, module: FileModule, name: string): TS.Expression | null {
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
export async function resolveExport(
  extraction: StaticExtraction,
  module: FileModule,
  name: string,
  depth: number,
): Promise<{ module: FileModule; expr: TS.Expression } | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const { ts } = extraction;
  const local = localInitializer(extraction, module, name);
  if (local) return { module, expr: local };

  if (name === "default") {
    for (const statement of module.sf.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const expr = statement.expression;
        // `export default appRouter` — chase the local identifier.
        if (ts.isIdentifier(expr)) {
          const resolved = await resolveIdentifier(extraction, module, expr.text, depth + 1);
          if (resolved) return resolved;
        }
        return { module, expr };
      }
    }
  }

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
export async function resolveIdentifier(
  extraction: StaticExtraction,
  module: FileModule,
  name: string,
  depth: number,
): Promise<{ module: FileModule; expr: TS.Expression } | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const local = localInitializer(extraction, module, name);
  if (local) return { module, expr: local };
  const imported = importMap(extraction, module).get(name);
  if (!imported || imported.imported === "*") return null;
  const resolved = await resolveImportSource(module.file, imported.specifier, extraction.root);
  if (!resolved) return null;
  const target = parseModule(extraction, resolved.file, resolved.source);
  return resolveExport(extraction, target, imported.imported, depth + 1);
}

export function calleeName(extraction: StaticExtraction, expr: TS.CallExpression): string | null {
  const { ts } = extraction;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

export function propertyKeyName(extraction: StaticExtraction, name: TS.PropertyName): string | null {
  const { ts } = extraction;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

export function literalValue(extraction: StaticExtraction, expr: TS.Expression): string | number | boolean | null | undefined {
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

// ---------------------------------------------------------------------------
// Zod → JSON Schema (static, fail-closed)
// ---------------------------------------------------------------------------

export interface ZodSchemaResult {
  schema: Record<string, unknown>;
  optional: boolean;
  recognized: boolean;
  reason?: string;
}

export const PERMISSIVE_INPUT: Record<string, unknown> = { type: "object", additionalProperties: true };

export function unrecognized(reason: string): ZodSchemaResult {
  return { schema: {}, optional: false, recognized: false, reason };
}

const ZOD_PASSTHROUGH_MODIFIERS = new Set([
  "trim", "refine", "superRefine", "transform", "brand", "readonly",
  "regex", "startsWith", "endsWith", "includes", "toLowerCase", "toUpperCase",
  "catch", "passthrough", "strict", "strip", "positive", "nonnegative", "negative",
  "nonpositive", "finite", "safe", "step", "multipleOf", "length", "nonempty", "cuid", "cuid2", "ulid", "nanoid",
]);

export async function zodFromExpression(
  extraction: StaticExtraction,
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
    return applyZodModifier(extraction, inner, method, expr);
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
  extraction: StaticExtraction,
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

function applyZodModifier(
  extraction: StaticExtraction,
  inner: ZodSchemaResult,
  method: string,
  call: TS.CallExpression,
): ZodSchemaResult {
  const { ts } = extraction;
  switch (method) {
    case "optional": return { ...inner, optional: true };
    case "describe": {
      // Descriptions are prompt-load-bearing (04 §1: the derived schema drives
      // the generation prompt) — carry a static string through instead of
      // dropping it as a passthrough modifier.
      const value = call.arguments[0] ? literalValue(extraction, call.arguments[0]) : undefined;
      return typeof value === "string" ? { ...inner, schema: { ...inner.schema, description: value } } : inner;
    }
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
