import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type TS from "typescript";
import type {
  DefinitionNode,
  EnumTypeDefinitionNode,
  EnumTypeExtensionNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
  InputObjectTypeExtensionNode,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  InterfaceTypeExtensionNode,
  ObjectTypeDefinitionNode,
  ObjectTypeExtensionNode,
  TypeNode,
  ValueNode,
} from "graphql";
import type { ExtractedTool, GraphqlBinding } from "../formats.js";
import {
  allocateToolName,
  graphqlRisk,
  graphqlToolFullName,
  resolveImportSource,
  walk,
} from "./common.js";
import { loadTypescript } from "./trpc.js";

/**
 * Static GraphQL extraction (04 §1, additive within vendo/tools@1).
 *
 * The schema is read statically from SDL files (parsed with the HOST's own
 * graphql package) and from code-first sources (@nestjs/graphql and
 * type-graphql resolver classes, parsed with the TypeScript compiler API) —
 * no host code is executed and no LLM runs. One tool per query and per
 * mutation; inputSchema is derived deterministically from GraphQL argument
 * types; execution documents carry depth-limited default selection sets.
 *
 * Fail-closed rules: subscriptions and operations whose arguments or return
 * types cannot be statically interpreted are emitted `disabled: true` with a
 * note; when several GraphQL endpoints defeat static operation-to-endpoint
 * attribution, every operation is emitted disabled rather than guessing.
 */

type Ts = typeof TS;
type GraphqlJs = { parse(source: string): { definitions: readonly DefinitionNode[] } };

export interface GraphqlExtractResult {
  tools: ExtractedTool[];
  warnings: string[];
}

const SOURCE_FILE_PATTERN = /\.(?:tsx?|jsx?)$/;
const SDL_FILE_PATTERN = /\.(?:graphql|graphqls|gql)$/i;
const DEFAULT_ENDPOINT = "/graphql";
const MAX_SELECTION_DEPTH = 2;
const MAX_RESOLVE_DEPTH = 16;
const MAX_SOURCE_FILES = 20_000;

const GRAPHQL_SERVER_DEPENDENCIES = [
  "graphql",
  "@nestjs/graphql",
  "graphql-yoga",
  "@graphql-yoga/nestjs",
  "@apollo/server",
  "apollo-server",
  "apollo-server-express",
  "apollo-server-micro",
  "type-graphql",
  "graphql-http",
  "express-graphql",
];

const CODE_FIRST_LIBS = new Set(["@nestjs/graphql", "type-graphql"]);
const ROUTE_SERVER_MARKER = /graphql-yoga|@apollo\/server|apollo-server-micro|graphql-http|@as-integrations\/next/;

/** Resolve the host's own graphql package (fail-closed). The fallback require
 * targets our devDependency so tests and monorepo dev work without a host
 * install. */
export function loadGraphqlJs(root: string): GraphqlJs | null {
  for (const base of [path.join(root, "package.json"), import.meta.url]) {
    try {
      return createRequire(base)("graphql") as GraphqlJs;
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

export async function detectGraphql(root: string): Promise<boolean> {
  const pkg = await readPackageJson(root);
  if (!pkg) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    if (GRAPHQL_SERVER_DEPENDENCIES.some((name) => name in (deps as Record<string, unknown>))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared operation IR (SDL and code-first sources assemble the same shape)
// ---------------------------------------------------------------------------

interface OperationArg {
  name: string;
  /** Printed GraphQL variable type, e.g. "[String!]!" — null when the type
   * cannot be statically named (the document is then not executable). */
  typeName: string | null;
  required: boolean;
  schema: Record<string, unknown>;
  reason?: string;
}

interface OperationDef {
  operation: string;
  type: "query" | "mutation" | "subscription";
  args: OperationArg[];
  /** "{ id name }" for object results, "" for scalar results, null when the
   * return type cannot be statically resolved. */
  selection: string | null;
  selectionReason?: string;
}

function inputSchemaFor(def: OperationDef): { schema: Record<string, unknown>; reasons: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const reasons: string[] = [];
  for (const arg of def.args) {
    properties[arg.name] = arg.schema;
    if (arg.required) required.push(arg.name);
    if (arg.reason) reasons.push(`${arg.name}: ${arg.reason}`);
  }
  if (def.args.length === 0) return { schema: { type: "object", properties: {} }, reasons };
  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    reasons,
  };
}

function documentFor(def: OperationDef, type: "query" | "mutation" | "subscription"): string | null {
  if (def.selection === null) return null;
  if (def.args.some((arg) => arg.typeName === null)) return null;
  const declarations = def.args.map((arg) => `$${arg.name}: ${arg.typeName!}`).join(", ");
  const bindings = def.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const head = `${type} ${def.operation}${declarations ? `(${declarations})` : ""}`;
  const field = `${def.operation}${bindings ? `(${bindings})` : ""}`;
  return `${head} { ${field}${def.selection ? ` ${def.selection}` : ""} }`;
}

interface EndpointResolution {
  endpoint: string;
  ambiguous: boolean;
  endpoints: string[];
}

function assembleTools(
  operations: OperationDef[],
  endpoints: EndpointResolution,
  warnings: string[],
): ExtractedTool[] {
  const tools: ExtractedTool[] = [];
  const usedNames = new Set<string>();
  const ambiguousNote = endpoints.ambiguous
    ? `operation-to-endpoint attribution is not static across ${endpoints.endpoints.length} GraphQL endpoints (${endpoints.endpoints.join(", ")}); bound to ${endpoints.endpoint}; verify the endpoint and enable via overrides.json`
    : null;

  for (const def of operations) {
    const { schema, reasons } = inputSchemaFor(def);
    const notes: string[] = [];
    let disabled = false;

    if (def.type === "subscription") {
      const name = allocateToolName(graphqlToolFullName(def.operation), "mutation", usedNames);
      const document = documentFor(def, "subscription");
      tools.push({
        name,
        description: `GraphQL subscription ${def.operation} is not invokable over a single HTTP request`,
        inputSchema: schema,
        risk: "destructive",
        disabled: true,
        note: [
          "GraphQL subscriptions are not invokable over the single-request HTTP transport; enable only after review; overrides.json can flip disabled/risk",
          ...(ambiguousNote ? [ambiguousNote] : []),
        ].join("; "),
        binding: bindingFor(def.operation, "mutation", endpoints.endpoint, document),
      });
      warnings.push(`graphql subscription ${def.operation} was emitted disabled: subscriptions are not invokable over a single HTTP request`);
      continue;
    }

    const unresolvableArgs = def.args.filter((arg) => arg.typeName === null).map((arg) => arg.name);
    if (unresolvableArgs.length > 0) {
      disabled = true;
      notes.push(`argument${unresolvableArgs.length > 1 ? "s" : ""} ${unresolvableArgs.map((argName) => `"${argName}"`).join(", ")} could not be statically declared, so no executable document was generated; enable only after review`);
    }
    if (def.selection === null) {
      disabled = true;
      notes.push(`return type could not be statically resolved (${def.selectionReason ?? "unrecognized type"}), so no executable document was generated; enable only after review`);
    }
    if (reasons.length > 0) {
      notes.push(`input schema partially interpreted; permissive where unknown (${reasons.join("; ")})`);
    }
    if (ambiguousNote) {
      disabled = true;
      notes.push(ambiguousNote);
    }

    const name = allocateToolName(graphqlToolFullName(def.operation), def.type, usedNames);
    const document = documentFor(def, def.type);
    tools.push({
      name,
      description: `GraphQL ${def.type} ${def.operation}`,
      inputSchema: schema,
      risk: graphqlRisk(def.type, def.operation),
      ...(disabled ? { disabled: true } : {}),
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      binding: bindingFor(def.operation, def.type, endpoints.endpoint, document),
    });
    if (unresolvableArgs.length > 0 || def.selection === null) {
      warnings.push(`graphql operation ${def.operation} was emitted disabled: ${notes[0]!}`);
    }
  }
  return tools;
}

function bindingFor(
  operation: string,
  type: "query" | "mutation",
  endpoint: string,
  document: string | null,
): GraphqlBinding {
  return {
    kind: "graphql",
    operation,
    type,
    endpoint,
    ...(document !== null ? { document } : {}),
  };
}

// ---------------------------------------------------------------------------
// SDL sources
// ---------------------------------------------------------------------------

interface SdlIndex {
  objects: Map<string, FieldDefinitionNode[]>;    // object + interface types
  inputs: Map<string, InputValueDefinitionNode[]>;
  enums: Map<string, string[]>;
  unions: Set<string>;
  declaredScalars: Set<string>;
  roots: { query: string; mutation: string; subscription: string };
}

type WithFields = ObjectTypeDefinitionNode | ObjectTypeExtensionNode | InterfaceTypeDefinitionNode | InterfaceTypeExtensionNode;
type WithInputFields = InputObjectTypeDefinitionNode | InputObjectTypeExtensionNode;
type WithEnumValues = EnumTypeDefinitionNode | EnumTypeExtensionNode;

function indexSdlDefinitions(documents: readonly DefinitionNode[][]): SdlIndex {
  const index: SdlIndex = {
    objects: new Map(),
    inputs: new Map(),
    enums: new Map(),
    unions: new Set(),
    declaredScalars: new Set(),
    roots: { query: "Query", mutation: "Mutation", subscription: "Subscription" },
  };
  const appendFields = (name: string, node: WithFields): void => {
    const fields = index.objects.get(name) ?? [];
    fields.push(...(node.fields ?? []));
    index.objects.set(name, fields);
  };
  for (const definitions of documents) {
    for (const definition of definitions) {
      switch (definition.kind) {
        case "SchemaDefinition":
        case "SchemaExtension":
          for (const operationType of definition.operationTypes ?? []) {
            index.roots[operationType.operation] = operationType.type.name.value;
          }
          break;
        case "ObjectTypeDefinition":
        case "ObjectTypeExtension":
        case "InterfaceTypeDefinition":
        case "InterfaceTypeExtension":
          appendFields(definition.name.value, definition as WithFields);
          break;
        case "InputObjectTypeDefinition":
        case "InputObjectTypeExtension": {
          const input = definition as WithInputFields;
          const fields = index.inputs.get(input.name.value) ?? [];
          fields.push(...(input.fields ?? []));
          index.inputs.set(input.name.value, fields);
          break;
        }
        case "EnumTypeDefinition":
        case "EnumTypeExtension": {
          const enumeration = definition as WithEnumValues;
          const values = index.enums.get(enumeration.name.value) ?? [];
          values.push(...(enumeration.values ?? []).map((value) => value.name.value));
          index.enums.set(enumeration.name.value, values);
          break;
        }
        case "UnionTypeDefinition":
        case "UnionTypeExtension":
          index.unions.add(definition.name.value);
          break;
        case "ScalarTypeDefinition":
        case "ScalarTypeExtension":
          index.declaredScalars.add(definition.name.value);
          break;
        default:
          break;
      }
    }
  }
  return index;
}

function printSdlType(node: TypeNode): string {
  if (node.kind === "NonNullType") return `${printSdlType(node.type)}!`;
  if (node.kind === "ListType") return `[${printSdlType(node.type)}]`;
  return node.name.value;
}

function unwrapSdlType(node: TypeNode): string {
  if (node.kind === "NonNullType" || node.kind === "ListType") return unwrapSdlType(node.type);
  return node.name.value;
}

const BUILTIN_SCALAR_SCHEMAS: Record<string, Record<string, unknown>> = {
  String: { type: "string" },
  ID: { type: "string" },
  Int: { type: "integer" },
  BigInt: { type: "integer" },
  Float: { type: "number" },
  BigFloat: { type: "number" },
  Boolean: { type: "boolean" },
  DateTime: { type: "string", format: "date-time" },
  Date: { type: "string", format: "date" },
  Time: { type: "string", format: "time" },
  UUID: { type: "string", format: "uuid" },
  JSON: {},
  JSONObject: {},
};

function literalValueNode(node: ValueNode): string | number | boolean | null | undefined {
  switch (node.kind) {
    case "StringValue":
    case "EnumValue":
      return node.value;
    case "IntValue":
    case "FloatValue":
      return Number(node.value);
    case "BooleanValue":
      return node.value;
    case "NullValue":
      return null;
    default:
      return undefined;
  }
}

function sdlSchemaFor(
  index: SdlIndex,
  node: TypeNode,
  seen: readonly string[],
): { schema: Record<string, unknown>; reason?: string } {
  if (node.kind === "NonNullType") return sdlSchemaFor(index, node.type, seen);
  if (node.kind === "ListType") {
    const items = sdlSchemaFor(index, node.type, seen);
    return { schema: { type: "array", items: items.schema }, ...(items.reason ? { reason: items.reason } : {}) };
  }
  const name = node.name.value;
  const builtin = BUILTIN_SCALAR_SCHEMAS[name];
  if (builtin && !index.inputs.has(name) && !index.enums.has(name)) return { schema: { ...builtin } };
  const values = index.enums.get(name);
  if (values) return { schema: { type: "string", enum: values } };
  const inputFields = index.inputs.get(name);
  if (inputFields) {
    if (seen.includes(name) || seen.length >= MAX_RESOLVE_DEPTH) {
      return { schema: {}, reason: `input type ${name} exceeded the static interpretation depth` };
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const reasons: string[] = [];
    for (const field of inputFields) {
      const value = sdlSchemaFor(index, field.type, [...seen, name]);
      const withDefault = applyDefault(value.schema, field.defaultValue);
      properties[field.name.value] = withDefault.schema;
      if (field.type.kind === "NonNullType" && !withDefault.hasDefault) required.push(field.name.value);
      if (value.reason) reasons.push(value.reason);
    }
    return {
      schema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
      ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    };
  }
  return { schema: {}, reason: `custom scalar ${name} is not statically interpreted` };
}

function applyDefault(
  schema: Record<string, unknown>,
  defaultValue: ValueNode | undefined,
): { schema: Record<string, unknown>; hasDefault: boolean } {
  if (!defaultValue) return { schema, hasDefault: false };
  const literal = literalValueNode(defaultValue);
  return {
    schema: literal !== undefined ? { ...schema, default: literal } : schema,
    hasDefault: true,
  };
}

function sdlSelectionFor(index: SdlIndex, node: TypeNode, depth: number): string {
  const name = unwrapSdlType(node);
  if (index.unions.has(name)) return "{ __typename }";
  const fields = index.objects.get(name);
  if (!fields) return ""; // scalar or enum leaf
  const parts: string[] = [];
  for (const field of fields) {
    if ((field.arguments ?? []).length > 0) continue; // parameterized fields never join default selections
    const fieldTypeName = unwrapSdlType(field.type);
    if (index.objects.has(fieldTypeName) || index.unions.has(fieldTypeName)) {
      if (depth >= MAX_SELECTION_DEPTH) continue;
      const nested = sdlSelectionFor(index, field.type, depth + 1);
      if (nested !== "") parts.push(`${field.name.value} ${nested}`);
      continue;
    }
    parts.push(field.name.value);
  }
  if (parts.length === 0) return "{ __typename }";
  return `{ ${parts.join(" ")} }`;
}

function sdlVariableType(node: TypeNode, hasDefault: boolean): string {
  const printed = printSdlType(node);
  // A non-null argument with a schema default still accepts a nullable
  // variable (spec: nullability + location default), and a nullable variable
  // is the only way the agent can omit the optional argument.
  if (hasDefault && printed.endsWith("!")) return printed.slice(0, -1);
  return printed;
}

function sdlOperations(index: SdlIndex): OperationDef[] {
  const operations: OperationDef[] = [];
  const rootEntries: Array<{ type: OperationDef["type"]; rootName: string }> = [
    { type: "query", rootName: index.roots.query },
    { type: "mutation", rootName: index.roots.mutation },
    { type: "subscription", rootName: index.roots.subscription },
  ];
  for (const { type, rootName } of rootEntries) {
    const fields = index.objects.get(rootName);
    if (!fields) continue;
    for (const field of fields) {
      const args: OperationArg[] = (field.arguments ?? []).map((argument) => {
        const value = sdlSchemaFor(index, argument.type, []);
        const withDefault = applyDefault(value.schema, argument.defaultValue);
        return {
          name: argument.name.value,
          typeName: sdlVariableType(argument.type, withDefault.hasDefault),
          required: argument.type.kind === "NonNullType" && !withDefault.hasDefault,
          schema: withDefault.schema,
          ...(value.reason ? { reason: value.reason } : {}),
        };
      });
      operations.push({
        operation: field.name.value,
        type,
        args,
        selection: sdlSelectionFor(index, field.type, 1),
      });
    }
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Code-first sources (@nestjs/graphql, type-graphql) — TypeScript AST
// ---------------------------------------------------------------------------

interface FileModule {
  file: string;
  source: string;
  sf: TS.SourceFile;
}

interface Extraction {
  ts: Ts;
  root: string;
  modules: Map<string, FileModule>;
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

/** import local name → specifier + imported name, for one module. */
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

type ResolvedNode = { module: FileModule; node: TS.Node };

/** Find a top-level declaration by name: variable initializer, class, enum,
 * or function declaration. */
function localDeclaration(extraction: Extraction, module: FileModule, name: string): TS.Node | null {
  const { ts } = extraction;
  for (const statement of module.sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          return declaration.initializer;
        }
      }
    }
    if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isFunctionDeclaration(statement))
        && statement.name?.text === name) {
      return statement;
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
): Promise<ResolvedNode | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const { ts } = extraction;
  const local = localDeclaration(extraction, module, name);
  if (local) return { module, node: local };

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

/** Resolve an identifier to its defining declaration, following local
 * declarations and one-hop-per-level imports. Returns null (fail-closed) for
 * anything defined outside the host root. */
async function resolveIdentifier(
  extraction: Extraction,
  module: FileModule,
  name: string,
  depth: number,
): Promise<ResolvedNode | null> {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const local = localDeclaration(extraction, module, name);
  if (local) return { module, node: local };
  const imported = importMap(extraction, module).get(name);
  if (!imported || imported.imported === "*") return null;
  const resolved = await resolveImportSource(module.file, imported.specifier, extraction.root);
  if (!resolved) return null;
  const target = parseModule(extraction, resolved.file, resolved.source);
  return resolveExport(extraction, target, imported.imported, depth + 1);
}

function decoratorsOf(ts: Ts, node: TS.Node): readonly TS.Decorator[] {
  const modern = ts as unknown as {
    canHaveDecorators?: (node: TS.Node) => boolean;
    getDecorators?: (node: TS.Node) => readonly TS.Decorator[] | undefined;
  };
  if (modern.canHaveDecorators && modern.getDecorators) {
    return modern.canHaveDecorators(node) ? modern.getDecorators(node) ?? [] : [];
  }
  const legacy = (node as { decorators?: readonly TS.Decorator[] }).decorators;
  return legacy ?? [];
}

interface DecoratorCall {
  name: string;
  args: readonly TS.Expression[];
}

/** Decorator calls on a node whose factory is imported from a code-first
 * GraphQL library — a same-named local helper never counts. */
function graphqlDecorators(extraction: Extraction, module: FileModule, node: TS.Node): DecoratorCall[] {
  const { ts } = extraction;
  const imports = importMap(extraction, module);
  const calls: DecoratorCall[] = [];
  for (const decorator of decoratorsOf(ts, node)) {
    const expr = decorator.expression;
    if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) continue;
    const imported = imports.get(expr.expression.text);
    if (!imported || !CODE_FIRST_LIBS.has(imported.specifier)) continue;
    calls.push({ name: imported.imported, args: expr.arguments });
  }
  return calls;
}

function objectProperty(ts: Ts, literal: TS.ObjectLiteralExpression, name: string): TS.Expression | null {
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
    if (key === name) return property.initializer;
  }
  return null;
}

function stringLiteralValue(ts: Ts, expr: TS.Expression | null): string | null {
  if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))) return expr.text;
  return null;
}

function isTruthyLiteral(ts: Ts, expr: TS.Expression | null): boolean {
  if (!expr) return false;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isStringLiteral(expr)) return true; // nullable: "items" / "itemsAndList"
  return false;
}

/** The statically-interpreted view of one GraphQL type expression. */
interface TypeInterpretation {
  /** Named GraphQL type with wrappers, e.g. "[Invoice!]" — null when unnameable. */
  typeName: string | null;
  schema: Record<string, unknown>;
  /** "" for scalar leaves, "{ ... }" for objects, null when unresolvable. */
  selection: string | null;
  reason?: string;
}

const CODE_FIRST_SCALARS: Record<string, { typeName: string; schema: Record<string, unknown> }> = {
  String: { typeName: "String", schema: { type: "string" } },
  Number: { typeName: "Float", schema: { type: "number" } },
  Boolean: { typeName: "Boolean", schema: { type: "boolean" } },
  Int: { typeName: "Int", schema: { type: "integer" } },
  Float: { typeName: "Float", schema: { type: "number" } },
  ID: { typeName: "ID", schema: { type: "string" } },
  Date: { typeName: "DateTime", schema: { type: "string", format: "date-time" } },
  GraphQLISODateTime: { typeName: "DateTime", schema: { type: "string", format: "date-time" } },
  GraphQLTimestamp: { typeName: "Timestamp", schema: { type: "number" } },
  GraphQLJSON: { typeName: "JSON", schema: {} },
  GraphQLJSONObject: { typeName: "JSONObject", schema: {} },
};

function scalarByName(name: string): TypeInterpretation | null {
  const scalar = CODE_FIRST_SCALARS[name];
  if (!scalar) return null;
  return { typeName: scalar.typeName, schema: { ...scalar.schema }, selection: "" };
}

function unresolvableType(reason: string): TypeInterpretation {
  return { typeName: null, schema: {}, selection: null, reason };
}

/** Interpret a `() => T` type expression from a decorator argument. */
async function interpretTypeExpression(
  extraction: Extraction,
  module: FileModule,
  expr: TS.Expression,
  depth: number,
): Promise<TypeInterpretation> {
  const { ts } = extraction;
  if (depth > MAX_RESOLVE_DEPTH) return unresolvableType("type nesting exceeded the static interpretation depth");
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    return interpretTypeExpression(extraction, module, expr.expression, depth + 1);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const element = expr.elements[0];
    if (!element) return unresolvableType("empty list type expression");
    const inner = await interpretTypeExpression(extraction, module, element, depth + 1);
    return {
      typeName: inner.typeName === null ? null : `[${inner.typeName}!]`,
      schema: { type: "array", items: inner.schema },
      selection: inner.selection,
      ...(inner.reason ? { reason: inner.reason } : {}),
    };
  }
  if (ts.isIdentifier(expr)) {
    const scalar = scalarByName(expr.text);
    if (scalar) return scalar;
    // The graphql-type-json package IS the JSON scalar — no resolution needed.
    const imported = importMap(extraction, module).get(expr.text);
    if (imported?.specifier === "graphql-type-json") {
      return { typeName: imported.imported === "GraphQLJSONObject" ? "JSONObject" : "JSON", schema: {}, selection: "" };
    }
    const resolved = await resolveIdentifier(extraction, module, expr.text, depth + 1);
    if (!resolved) return unresolvableType(`type reference "${expr.text}" could not be statically resolved`);
    return interpretResolvedType(extraction, resolved, expr.text, depth + 1);
  }
  return unresolvableType("type expression shape is not statically interpreted");
}

async function interpretResolvedType(
  extraction: Extraction,
  resolved: ResolvedNode,
  referenceName: string,
  depth: number,
): Promise<TypeInterpretation> {
  const { ts } = extraction;
  const { node, module } = resolved;
  if (ts.isClassDeclaration(node)) {
    return interpretClassType(extraction, module, node, depth);
  }
  if (ts.isEnumDeclaration(node)) {
    const values = node.members
      .map((member) => ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null)
      .filter((value): value is string => value !== null);
    return { typeName: node.name.text, schema: { type: "string", enum: values }, selection: "" };
  }
  // `new GraphQLScalarType({ name: "UUID", ... })` — a custom scalar constant.
  if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
    const argument = node.arguments?.[0];
    if (argument && ts.isObjectLiteralExpression(argument)) {
      const name = stringLiteralValue(ts, objectProperty(ts, argument, "name"));
      if (name) {
        const builtin = BUILTIN_SCALAR_SCHEMAS[name];
        return {
          typeName: name,
          schema: builtin ? { ...builtin } : {},
          selection: "",
          ...(builtin ? {} : { reason: `custom scalar ${name} is not statically interpreted` }),
        };
      }
    }
  }
  return unresolvableType(`type reference "${referenceName}" is not a statically interpretable GraphQL type`);
}

interface ClassFieldInfo {
  name: string;
  interpretation: TypeInterpretation;
  optional: boolean;
  hasArguments: boolean;
}

function graphqlClassName(extraction: Extraction, module: FileModule, node: TS.ClassDeclaration): string | null {
  const { ts } = extraction;
  for (const call of graphqlDecorators(extraction, module, node)) {
    if (!["ObjectType", "InputType", "ArgsType", "InterfaceType"].includes(call.name)) continue;
    const first = call.args[0];
    if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
    return node.name?.text ?? null;
  }
  return node.name?.text ?? null;
}

/** Interpret a TS type annotation as a GraphQL type (the code-first implicit
 * scalar inference: string/number/boolean; class references resolve). */
async function interpretTypeAnnotation(
  extraction: Extraction,
  module: FileModule,
  annotation: TS.TypeNode | undefined,
  depth: number,
): Promise<TypeInterpretation> {
  const { ts } = extraction;
  if (!annotation) return unresolvableType("no static type annotation");
  if (annotation.kind === ts.SyntaxKind.StringKeyword) return scalarByName("String")!;
  if (annotation.kind === ts.SyntaxKind.NumberKeyword) return scalarByName("Number")!;
  if (annotation.kind === ts.SyntaxKind.BooleanKeyword) return scalarByName("Boolean")!;
  if (ts.isArrayTypeNode(annotation)) {
    const inner = await interpretTypeAnnotation(extraction, module, annotation.elementType, depth + 1);
    return {
      typeName: inner.typeName === null ? null : `[${inner.typeName}!]`,
      schema: { type: "array", items: inner.schema },
      selection: inner.selection,
      ...(inner.reason ? { reason: inner.reason } : {}),
    };
  }
  if (ts.isTypeReferenceNode(annotation) && ts.isIdentifier(annotation.typeName)) {
    const name = annotation.typeName.text;
    if (name === "Promise" || name === "Array") {
      return interpretTypeAnnotation(extraction, module, annotation.typeArguments?.[0], depth + 1);
    }
    const scalar = scalarByName(name);
    if (scalar && name !== "Number") return scalar; // Date and friends
    const resolved = await resolveIdentifier(extraction, module, name, depth + 1);
    if (!resolved) return unresolvableType(`type reference "${name}" could not be statically resolved`);
    return interpretResolvedType(extraction, resolved, name, depth + 1);
  }
  return unresolvableType("type annotation is not statically interpreted");
}

async function classFields(
  extraction: Extraction,
  module: FileModule,
  node: TS.ClassDeclaration,
  depth: number,
): Promise<ClassFieldInfo[]> {
  const { ts } = extraction;
  const fields: ClassFieldInfo[] = [];
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) && !ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member)) continue;
    const fieldCall = graphqlDecorators(extraction, module, member).find((call) => call.name === "Field");
    if (!fieldCall) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
    if (!name) continue;

    let interpretation: TypeInterpretation | null = null;
    const first = fieldCall.args[0];
    const options = fieldCall.args.find((argument) => ts.isObjectLiteralExpression(argument)) as TS.ObjectLiteralExpression | undefined;
    if (first && ts.isArrowFunction(first)) {
      interpretation = await interpretTypeExpression(extraction, module, unwrapArrowBody(ts, first), depth + 1);
    }
    if (!interpretation) {
      interpretation = await interpretTypeAnnotation(extraction, module, member.type, depth + 1);
    }
    const nullable = options ? isTruthyLiteral(ts, objectProperty(ts, options, "nullable")) : false;
    const questioned = ts.isPropertyDeclaration(member) && member.questionToken !== undefined;
    fields.push({
      name,
      interpretation,
      optional: nullable || questioned,
      hasArguments: ts.isMethodDeclaration(member) && member.parameters.length > 0,
    });
  }
  return fields;
}

async function interpretClassType(
  extraction: Extraction,
  module: FileModule,
  node: TS.ClassDeclaration,
  depth: number,
): Promise<TypeInterpretation> {
  const typeName = graphqlClassName(extraction, module, node);
  if (depth > MAX_RESOLVE_DEPTH) return unresolvableType("type nesting exceeded the static interpretation depth");
  const fields = await classFields(extraction, module, node, depth);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const reasons: string[] = [];
  const selectionParts: string[] = [];
  for (const field of fields) {
    properties[field.name] = field.interpretation.schema;
    if (!field.optional && field.interpretation.typeName !== null) required.push(field.name);
    if (field.interpretation.reason) reasons.push(`${field.name}: ${field.interpretation.reason}`);
    if (field.hasArguments) continue;
    if (field.interpretation.selection === "") selectionParts.push(field.name);
    else if (field.interpretation.selection !== null && depth < MAX_SELECTION_DEPTH) {
      selectionParts.push(`${field.name} ${field.interpretation.selection}`);
    }
  }
  return {
    typeName,
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    selection: selectionParts.length === 0 ? "{ __typename }" : `{ ${selectionParts.join(" ")} }`,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

function unwrapArrowBody(ts: Ts, arrow: TS.ArrowFunction): TS.Expression {
  if (ts.isBlock(arrow.body)) {
    for (const statement of arrow.body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) return statement.expression;
    }
  }
  return arrow.body as TS.Expression;
}

function variableTypeFor(interpretation: TypeInterpretation, optional: boolean): string | null {
  if (interpretation.typeName === null) return null;
  return optional ? interpretation.typeName : `${interpretation.typeName}!`;
}

/** Arguments for one resolver method: named @Args entries plus expanded
 * @Args() args-classes. */
async function methodArgs(
  extraction: Extraction,
  module: FileModule,
  method: TS.MethodDeclaration,
): Promise<{ args: OperationArg[]; unresolved: string[] }> {
  const { ts } = extraction;
  const args: OperationArg[] = [];
  const unresolved: string[] = [];
  for (const parameter of method.parameters) {
    const argsCall = graphqlDecorators(extraction, module, parameter).find((call) => call.name === "Args");
    if (!argsCall) continue;
    const nameLiteral = stringLiteralValue(ts, argsCall.args[0] ?? null);
    const options = argsCall.args.find((argument) => ts.isObjectLiteralExpression(argument)) as TS.ObjectLiteralExpression | undefined;

    if (nameLiteral !== null) {
      const typeArrow = options ? objectProperty(ts, options, "type") : null;
      const interpretation = typeArrow && ts.isArrowFunction(typeArrow)
        ? await interpretTypeExpression(extraction, module, unwrapArrowBody(ts, typeArrow), 0)
        : await interpretTypeAnnotation(extraction, module, parameter.type, 0);
      const nullable = options ? isTruthyLiteral(ts, objectProperty(ts, options, "nullable")) : false;
      const hasDefault = (options ? objectProperty(ts, options, "defaultValue") : null) !== null
        || parameter.initializer !== undefined;
      const optional = nullable || hasDefault || parameter.questionToken !== undefined;
      const typeName = variableTypeFor(interpretation, optional);
      if (typeName === null) unresolved.push(nameLiteral);
      args.push({
        name: nameLiteral,
        typeName,
        required: !optional && typeName !== null,
        schema: interpretation.typeName === null ? {} : interpretation.schema,
        ...(interpretation.reason ? { reason: interpretation.reason } : {}),
      });
      continue;
    }

    // `@Args() args: SearchArgs` — the class's fields are individual arguments.
    const annotation = parameter.type;
    if (!annotation || !ts.isTypeReferenceNode(annotation) || !ts.isIdentifier(annotation.typeName)) {
      unresolved.push(parameter.name.getText(module.sf));
      continue;
    }
    const resolved = await resolveIdentifier(extraction, module, annotation.typeName.text, 0);
    if (!resolved || !ts.isClassDeclaration(resolved.node)) {
      unresolved.push(annotation.typeName.text);
      continue;
    }
    const fields = await classFields(extraction, resolved.module, resolved.node, 0);
    for (const field of fields) {
      const typeName = variableTypeFor(field.interpretation, field.optional);
      if (typeName === null) unresolved.push(field.name);
      args.push({
        name: field.name,
        typeName,
        required: !field.optional && typeName !== null,
        schema: field.interpretation.typeName === null ? {} : field.interpretation.schema,
        ...(field.interpretation.reason ? { reason: field.interpretation.reason } : {}),
      });
    }
  }
  return { args, unresolved };
}

const OPERATION_DECORATORS = new Set(["Query", "Mutation", "Subscription"]);

async function codeFirstOperations(
  extraction: Extraction,
  module: FileModule,
  warnings: string[],
): Promise<OperationDef[]> {
  const { ts } = extraction;
  const operations: OperationDef[] = [];
  const visit = async (node: TS.Node): Promise<void> => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const operationCall = graphqlDecorators(extraction, module, member)
          .find((call) => OPERATION_DECORATORS.has(call.name));
        if (!operationCall) continue;
        const methodName = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
        if (!methodName) continue;
        const options = operationCall.args.find((argument) => ts.isObjectLiteralExpression(argument)) as TS.ObjectLiteralExpression | undefined;
        const operation = (options ? stringLiteralValue(ts, objectProperty(ts, options, "name")) : null) ?? methodName;
        const type = operationCall.name === "Query" ? "query" as const
          : operationCall.name === "Mutation" ? "mutation" as const
          : "subscription" as const;

        const typeArrow = operationCall.args[0];
        const returnInterpretation = typeArrow && ts.isArrowFunction(typeArrow)
          ? await interpretTypeExpression(extraction, module, unwrapArrowBody(ts, typeArrow), 0)
          : await interpretTypeAnnotation(extraction, module, member.type, 0);
        const { args } = await methodArgs(extraction, module, member);
        operations.push({
          operation,
          type,
          args,
          selection: returnInterpretation.selection,
          ...(returnInterpretation.selection === null && returnInterpretation.reason
            ? { selectionReason: returnInterpretation.reason }
            : {}),
        });
      }
    }
    for (const child of node.getChildren(module.sf)) await visit(child);
  };
  try {
    await visit(module.sf);
  } catch (cause) {
    warnings.push(`graphql code-first parse failed for ${path.relative(extraction.root, module.file)}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return operations;
}

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

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

function endpointFromRouteFile(relativePath: string): string | null {
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

function graphqlEndpointLiteral(source: string): string | null {
  const match = source.match(/graphqlEndpoint\s*:\s*["'`](\/[^"'`\s]*)["'`]/);
  return match?.[1] ?? null;
}

/** All `path: "/x"` string literals within a node (a GraphQLModule options
 * object or a resolved module factory body). Non-absolute literals — like a
 * playground's `path: 'metadata'` — never count as endpoints. */
function absolutePathLiterals(ts: Ts, node: TS.Node): string[] {
  const literals: string[] = [];
  const visit = (current: TS.Node): void => {
    if (ts.isPropertyAssignment(current)) {
      const key = ts.isIdentifier(current.name) || ts.isStringLiteral(current.name) ? current.name.text : null;
      if (key === "path") {
        const value = stringLiteralValue(ts, current.initializer);
        if (value?.startsWith("/")) literals.push(value);
      }
    }
    current.forEachChild(visit);
  };
  visit(node);
  return literals;
}

async function nestEndpoints(
  extraction: Extraction,
  module: FileModule,
): Promise<string[]> {
  const { ts } = extraction;
  const endpoints: string[] = [];
  const visits: Array<Promise<void>> = [];
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "GraphQLModule"
        && /^forRoot(Async)?$/.test(node.expression.name.text)) {
      const options = node.arguments[0];
      visits.push((async () => {
        if (!options || !ts.isObjectLiteralExpression(options)) {
          endpoints.push(DEFAULT_ENDPOINT);
          return;
        }
        const direct = absolutePathLiterals(ts, module.sf, options);
        if (direct.length > 0) {
          endpoints.push(direct[0]!);
          return;
        }
        const factory = objectProperty(ts, options, "useFactory");
        if (factory && ts.isIdentifier(factory)) {
          const resolved = await resolveIdentifier(extraction, module, factory.text, 0);
          if (resolved) {
            const fromFactory = absolutePathLiterals(extraction.ts, resolved.module.sf, resolved.node);
            if (fromFactory.length > 0) {
              endpoints.push(fromFactory[0]!);
              return;
            }
          }
        }
        endpoints.push(DEFAULT_ENDPOINT);
      })());
    }
    node.forEachChild(visit);
  };
  visit(module.sf);
  await Promise.all(visits);
  return endpoints;
}

// ---------------------------------------------------------------------------
// Extraction entry point
// ---------------------------------------------------------------------------

export async function extractGraphql(root: string): Promise<GraphqlExtractResult> {
  const warnings: string[] = [];

  const sdlFiles = await walk(root, (relativePath) => SDL_FILE_PATTERN.test(relativePath));
  // Test sources never describe a live API surface — a mock resolver in a
  // spec must not become a host tool.
  const testFilePattern = /(?:^|[\\/])(?:__tests__|__mocks__)[\\/]|\.(?:spec|test)\.[cm]?[jt]sx?$/;
  const sourceFiles = await walk(
    root,
    (relativePath) => SOURCE_FILE_PATTERN.test(relativePath) && !/\.d\.ts$/.test(relativePath) && !testFilePattern.test(relativePath),
    MAX_SOURCE_FILES,
  );

  const sources = new Map<string, string>();
  for (const file of sourceFiles) {
    try {
      sources.set(file, await fs.readFile(file, "utf8"));
    } catch {
      // Unreadable sources never fail extraction.
    }
  }

  const codeFirstFiles = [...sources.entries()].filter(([, source]) =>
    (source.includes("@nestjs/graphql") || source.includes("\"type-graphql\"") || source.includes("'type-graphql'"))
    && /@(?:Query|Mutation|Subscription)\s*\(/.test(source));

  // --- Endpoint discovery -------------------------------------------------
  const endpointSet = new Set<string>();
  let extraction: Extraction | null = null;
  const ensureExtraction = (): Extraction | null => {
    if (extraction) return extraction;
    const ts = loadTypescript(root);
    if (!ts) return null;
    extraction = { ts, root, modules: new Map() };
    return extraction;
  };

  for (const [file, source] of sources) {
    const relativePath = path.relative(root, file);
    if (isRouteFileCandidate(relativePath) && ROUTE_SERVER_MARKER.test(source)) {
      const endpoint = graphqlEndpointLiteral(source) ?? endpointFromRouteFile(relativePath) ?? DEFAULT_ENDPOINT;
      endpointSet.add(endpoint.length > 1 ? endpoint.replace(/\/+$/, "") : endpoint);
      continue;
    }
    if (source.includes("GraphQLModule")) {
      const active = ensureExtraction();
      if (active) {
        const module = parseModule(active, file, source);
        for (const endpoint of await nestEndpoints(active, module)) {
          endpointSet.add(endpoint.length > 1 ? endpoint.replace(/\/+$/, "") : endpoint);
        }
      }
      continue;
    }
    // Standalone yoga servers declare their endpoint on createYoga.
    if (source.includes("createYoga(")) {
      const literal = graphqlEndpointLiteral(source);
      if (literal) endpointSet.add(literal.length > 1 ? literal.replace(/\/+$/, "") : literal);
    }
  }

  // --- SDL operations -----------------------------------------------------
  const sdlOperationDefs: OperationDef[] = [];
  if (sdlFiles.length > 0) {
    const graphqlJs = loadGraphqlJs(root);
    if (!graphqlJs) {
      warnings.push("graphql SDL extraction skipped: the graphql package could not be resolved from the host package");
    } else {
      const documents: DefinitionNode[][] = [];
      for (const file of sdlFiles) {
        try {
          const source = await fs.readFile(file, "utf8");
          documents.push([...graphqlJs.parse(source).definitions]);
        } catch (cause) {
          warnings.push(`graphql SDL file ${path.relative(root, file)} could not be parsed: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);
        }
      }
      const index = indexSdlDefinitions(documents);
      sdlOperationDefs.push(...sdlOperations(index));
    }
  }

  // --- Code-first operations ----------------------------------------------
  const codeFirstOperationDefs: OperationDef[] = [];
  if (codeFirstFiles.length > 0) {
    const active = ensureExtraction();
    if (!active) {
      warnings.push("graphql code-first extraction skipped: the TypeScript compiler could not be resolved from the host package");
    } else {
      for (const [file, source] of codeFirstFiles) {
        const module = parseModule(active, file, source);
        codeFirstOperationDefs.push(...await codeFirstOperations(active, module, warnings));
      }
    }
  }

  if (sdlOperationDefs.length === 0 && codeFirstOperationDefs.length === 0) {
    return {
      tools: [],
      warnings: [
        ...warnings,
        "graphql detected (graphql dependency) but no SDL schema or code-first resolvers were found; no graphql tools extracted",
      ],
    };
  }

  // SDL is the more authoritative schema description; code-first duplicates
  // of the same operation name are dropped.
  const seen = new Set<string>();
  const operations: OperationDef[] = [];
  for (const def of [...sdlOperationDefs, ...codeFirstOperationDefs]) {
    if (seen.has(def.operation)) continue;
    seen.add(def.operation);
    operations.push(def);
  }

  const endpoints = [...endpointSet].sort();
  const resolution: EndpointResolution = {
    endpoint: endpoints.includes(DEFAULT_ENDPOINT) ? DEFAULT_ENDPOINT : endpoints[0] ?? DEFAULT_ENDPOINT,
    ambiguous: endpoints.length > 1,
    endpoints,
  };
  if (resolution.ambiguous) {
    warnings.push(`graphql: ${endpoints.length} GraphQL endpoints detected (${endpoints.join(", ")}); operation-to-endpoint attribution is not static, so every operation is emitted disabled`);
  }

  return { tools: assembleTools(operations, resolution, warnings), warnings };
}

/** The endpoints graphql tools were extracted from — route-scan tools under
 * these paths are shadowed (the GraphQL transport route is not a REST surface). */
export function graphqlEndpoints(tools: readonly ExtractedTool[]): string[] {
  const endpoints = new Set<string>();
  for (const tool of tools) {
    if (tool.binding.kind === "graphql") endpoints.add(tool.binding.endpoint);
  }
  return [...endpoints];
}
