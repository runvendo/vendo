import { promises as fs } from "node:fs";
import path from "node:path";
import type TS from "typescript";
import type { ExtractedTool, ServerActionBinding } from "../formats.js";
import {
  allocateToolName,
  serverActionRisk,
  serverActionToolFullName,
  walk,
} from "./common.js";
import {
  MAX_RESOLVE_DEPTH,
  hasDependency,
  loadTypescript,
  localInitializer,
  parseModule,
  resolveIdentifier,
  zodFromExpression,
  type FileModule,
  type StaticExtraction,
  type Ts,
  type ZodSchemaResult,
} from "./static-ts.js";

/**
 * Static Next.js server-action extraction (04 §1, additive within
 * vendo/tools@1). `"use server"` modules and functions are parsed with the
 * TypeScript compiler API — no host code runs. Input schemas come from
 * validators where statically interpretable (zod via `z.infer<typeof X>`
 * annotations, primitive/object-literal type annotations); everything else
 * fails closed to a permissive parameter with a note.
 *
 * Execution is direct in-process registration: the generated wiring file
 * imports the action modules and passes a registration map into
 * `createVendo({ serverActions })`. Inline actions (a `"use server"` directive
 * inside a component-scoped function) are real host surface but not
 * importable, so they are emitted `disabled: true` with a note. Exports the
 * extractor cannot confirm are functions are emitted disabled + destructive —
 * never silently auto-allowed.
 */

export interface ServerActionsExtractResult {
  tools: ExtractedTool[];
  warnings: string[];
}

export interface ServerActionRegistration {
  module: string;
  exportName: string;
}

const SOURCE_FILE_PATTERN = /\.(?:tsx?|jsx?)$/;
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export async function detectServerActions(root: string): Promise<boolean> {
  return hasDependency(root, "next");
}

/** The registration-map key the generated wiring and the runtime agree on. */
export function serverActionKey(binding: Pick<ServerActionBinding, "module" | "exportName">): string {
  return `${binding.module}#${binding.exportName}`;
}

/** Enabled server actions only — the entries the generated wiring file must
 * import and register. Disabled tools (inline, unclassifiable) stay out: the
 * runtime fails closed on the missing key instead. */
export function serverActionRegistrations(tools: readonly ExtractedTool[]): ServerActionRegistration[] {
  const seen = new Set<string>();
  const registrations: ServerActionRegistration[] = [];
  for (const tool of tools) {
    if (tool.binding.kind !== "server-action" || tool.disabled === true) continue;
    const key = serverActionKey(tool.binding);
    if (seen.has(key)) continue;
    seen.add(key);
    registrations.push({ module: tool.binding.module, exportName: tool.binding.exportName });
  }
  return registrations.sort((left, right) =>
    left.module.localeCompare(right.module) || left.exportName.localeCompare(right.exportName));
}

interface Extraction extends StaticExtraction {
  warnings: string[];
}

/** Leading directive prologue contains "use server". */
function hasDirective(ts: Ts, statements: readonly TS.Statement[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteralLike(statement.expression)) return false;
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

function isModuleLevelUseServer(ts: Ts, sf: TS.SourceFile): boolean {
  return hasDirective(ts, sf.statements);
}

type FunctionNode = TS.FunctionDeclaration | TS.FunctionExpression | TS.ArrowFunction;

function unwrapExpression(ts: Ts, expr: TS.Expression): TS.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

function functionNode(ts: Ts, expr: TS.Expression): FunctionNode | null {
  const unwrapped = unwrapExpression(ts, expr);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped;
  return null;
}

// ---------------------------------------------------------------------------
// Parameter type → JSON Schema (static, fail-closed)
// ---------------------------------------------------------------------------

const recognizedSchema = (schema: Record<string, unknown>): ZodSchemaResult =>
  ({ schema, optional: false, recognized: true });

const notInterpreted = (reason: string): ZodSchemaResult =>
  ({ schema: {}, optional: false, recognized: false, reason });

function entityNameText(ts: Ts, name: TS.EntityName): string {
  return ts.isIdentifier(name) ? name.text : `${entityNameText(ts, name.left)}.${name.right.text}`;
}

/** `z.infer<typeof X>` / `z.input` / `z.output` — resolve X and statically
 * interpret the zod schema it names. */
async function zodInferSchema(
  extraction: Extraction,
  module: FileModule,
  type: TS.TypeReferenceNode,
  depth: number,
): Promise<ZodSchemaResult | null> {
  const { ts } = extraction;
  const name = entityNameText(ts, type.typeName);
  if (!/(?:^|\.)(?:infer|input|output)$/.test(name)) return null;
  const argument = type.typeArguments?.[0];
  if (!argument || !ts.isTypeQueryNode(argument) || !ts.isIdentifier(argument.exprName)) {
    return notInterpreted(`${name}<...> argument is not a typeof reference`);
  }
  const resolved = await resolveIdentifier(extraction, module, argument.exprName.text, depth + 1);
  if (!resolved) return notInterpreted(`schema reference "${argument.exprName.text}" could not be statically resolved`);
  return zodFromExpression(extraction, resolved.module, resolved.expr, depth + 1);
}

async function typeNodeSchema(
  extraction: Extraction,
  module: FileModule,
  type: TS.TypeNode,
  depth: number,
): Promise<ZodSchemaResult> {
  if (depth > MAX_RESOLVE_DEPTH) return notInterpreted("type nesting exceeded the static interpretation depth");
  const { ts } = extraction;

  if (ts.isParenthesizedTypeNode(type)) return typeNodeSchema(extraction, module, type.type, depth + 1);
  switch (type.kind) {
    case ts.SyntaxKind.StringKeyword: return recognizedSchema({ type: "string" });
    case ts.SyntaxKind.NumberKeyword: return recognizedSchema({ type: "number" });
    case ts.SyntaxKind.BooleanKeyword: return recognizedSchema({ type: "boolean" });
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword: return recognizedSchema({});
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.VoidKeyword: return { schema: {}, optional: true, recognized: true };
    default: break;
  }
  if (ts.isLiteralTypeNode(type)) {
    const literal = type.literal;
    if (ts.isStringLiteralLike(literal)) return recognizedSchema({ const: literal.text });
    if (ts.isNumericLiteral(literal)) return recognizedSchema({ const: Number(literal.text) });
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return recognizedSchema({ const: true });
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return recognizedSchema({ const: false });
    if (literal.kind === ts.SyntaxKind.NullKeyword) return recognizedSchema({ type: "null" });
    return notInterpreted("literal type is not statically interpreted");
  }
  if (ts.isArrayTypeNode(type)) {
    const items = await typeNodeSchema(extraction, module, type.elementType, depth + 1);
    return items.recognized
      ? recognizedSchema({ type: "array", items: items.schema })
      : { schema: { type: "array" }, optional: false, recognized: true, reason: items.reason };
  }
  if (ts.isUnionTypeNode(type)) {
    const options: Record<string, unknown>[] = [];
    let optional = false;
    let nullable = false;
    for (const member of type.types) {
      if (member.kind === ts.SyntaxKind.UndefinedKeyword) {
        optional = true;
        continue;
      }
      if (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword) {
        nullable = true;
        continue;
      }
      const option = await typeNodeSchema(extraction, module, member, depth + 1);
      if (!option.recognized) return notInterpreted(option.reason ?? "union member is not statically interpreted");
      options.push(option.schema);
    }
    if (options.length === 0) return { schema: {}, optional, recognized: true };
    const allStringConsts = options.every((option) => typeof option.const === "string" && Object.keys(option).length === 1);
    let schema: Record<string, unknown> = allStringConsts
      ? { type: "string", enum: options.map((option) => option.const) }
      : options.length === 1 ? options[0]! : { anyOf: options };
    if (nullable) schema = { anyOf: [schema, { type: "null" }] };
    return { schema, optional, recognized: true };
  }
  if (ts.isTypeLiteralNode(type)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const reasons: string[] = [];
    for (const member of type.members) {
      if (ts.isIndexSignatureDeclaration(member)) continue; // stays additive below
      if (!ts.isPropertySignature(member) || !member.name) return notInterpreted("object type member is not a plain property");
      const key = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
      if (key === null) return notInterpreted("object type member has a computed name");
      const value = member.type
        ? await typeNodeSchema(extraction, module, member.type, depth + 1)
        : notInterpreted("object type member has no type annotation");
      properties[key] = value.recognized ? value.schema : {};
      if (!value.recognized && value.reason) reasons.push(`${key}: ${value.reason}`);
      if (member.questionToken === undefined && !value.optional && value.recognized) required.push(key);
    }
    const hasIndexSignature = type.members.some((member) => ts.isIndexSignatureDeclaration(member));
    const schema: Record<string, unknown> = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: hasIndexSignature,
    };
    if (reasons.length > 0) return { schema, optional: false, recognized: true, reason: reasons.join("; ") };
    return recognizedSchema(schema);
  }
  if (ts.isTypeReferenceNode(type)) {
    const zod = await zodInferSchema(extraction, module, type, depth);
    if (zod !== null) return zod;
    const name = entityNameText(ts, type.typeName);
    if (name === "Date") return recognizedSchema({ type: "string", format: "date-time" });
    if (name === "Array" && type.typeArguments?.length === 1) {
      const items = await typeNodeSchema(extraction, module, type.typeArguments[0]!, depth + 1);
      return items.recognized
        ? recognizedSchema({ type: "array", items: items.schema })
        : { schema: { type: "array" }, optional: false, recognized: true, reason: items.reason };
    }
    if (name === "Record" && type.typeArguments?.length === 2) {
      const value = await typeNodeSchema(extraction, module, type.typeArguments[1]!, depth + 1);
      return recognizedSchema({ type: "object", additionalProperties: value.recognized ? value.schema : true });
    }
    return notInterpreted(`type "${name}" is not statically interpreted`);
  }
  return notInterpreted("parameter type is not statically interpreted");
}

// ---------------------------------------------------------------------------
// Action collection
// ---------------------------------------------------------------------------

interface ActionParam {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
  reason?: string;
}

interface CollectedAction {
  module: FileModule;
  moduleRel: string;
  exportName: string;
  /** The name risk labeling and tool naming derive from (the declared function
   * name for default exports, the export name otherwise). */
  riskName: string;
  params: ActionParam[];
  /** Fail-closed dispositions. */
  disabled?: "inline" | "unclassifiable";
  unclassifiableReason?: string;
}

async function actionParams(
  extraction: Extraction,
  module: FileModule,
  fn: FunctionNode,
): Promise<ActionParam[]> {
  const { ts } = extraction;
  const params: ActionParam[] = [];
  for (const [index, parameter] of fn.parameters.entries()) {
    const name = ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`;
    const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
    if (parameter.dotDotDotToken !== undefined) {
      params.push({ name, schema: { type: "array" }, required: false, reason: `${name}: rest parameters are not statically interpreted` });
      continue;
    }
    const interpreted = parameter.type
      ? await typeNodeSchema(extraction, module, parameter.type, 0)
      : notInterpreted("parameter has no statically interpretable type");
    params.push({
      name,
      schema: interpreted.recognized ? interpreted.schema : {},
      required: !optional && !interpreted.optional,
      ...(interpreted.reason !== undefined || !interpreted.recognized
        ? { reason: `${name}: ${interpreted.reason ?? "not statically interpreted"}` }
        : {}),
    });
  }
  return params;
}

function moduleStem(moduleRel: string): string {
  return path.posix.basename(moduleRel).replace(SOURCE_FILE_PATTERN, "");
}

async function collectModuleActions(
  extraction: Extraction,
  module: FileModule,
  moduleRel: string,
  out: CollectedAction[],
): Promise<void> {
  const { ts } = extraction;
  const base = { module, moduleRel };

  const pushFunction = async (exportName: string, riskName: string, fn: FunctionNode): Promise<void> => {
    out.push({ ...base, exportName, riskName, params: await actionParams(extraction, module, fn) });
  };
  const pushUnclassifiable = (exportName: string, reason: string): void => {
    out.push({ ...base, exportName, riskName: exportName, params: [], disabled: "unclassifiable", unclassifiableReason: reason });
  };

  for (const statement of module.sf.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const isExported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(statement) && isExported) {
      const declared = statement.name?.text;
      const exportName = isDefault ? "default" : declared;
      if (!exportName) continue;
      await pushFunction(exportName, declared ?? moduleStem(moduleRel), statement);
      continue;
    }
    if (ts.isVariableStatement(statement) && isExported) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const exportName = declaration.name.text;
        if (!declaration.initializer) continue;
        const fn = functionNode(ts, declaration.initializer);
        if (fn) await pushFunction(exportName, exportName, fn);
        else pushUnclassifiable(exportName, "the export is not a statically confirmable function");
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      let expr = unwrapExpression(ts, statement.expression);
      let riskName = moduleStem(moduleRel);
      if (ts.isIdentifier(expr)) {
        riskName = expr.text;
        const local = localFunction(extraction, module, expr.text);
        if (local) {
          await pushFunction("default", riskName, local);
          continue;
        }
        pushUnclassifiable("default", `default export "${expr.text}" is not a statically confirmable function`);
        continue;
      }
      const fn = functionNode(ts, expr);
      if (fn) await pushFunction("default", ts.isFunctionExpression(fn) && fn.name ? fn.name.text : riskName, fn);
      else pushUnclassifiable("default", "the default export is not a statically confirmable function");
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.moduleSpecifier !== undefined) {
        extraction.warnings.push(`server-actions: re-exports from ${moduleRel} are not followed; declare actions in the "use server" module itself`);
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const exportName = element.name.text;
        const localName = (element.propertyName ?? element.name).text;
        const local = localFunction(extraction, module, localName);
        if (local) await pushFunction(exportName, localName, local);
        else pushUnclassifiable(exportName, `exported binding "${localName}" is not a statically confirmable function`);
      }
    }
  }
}

/** A local function declaration or function-initialized variable by name. */
function localFunction(extraction: Extraction, module: FileModule, name: string): FunctionNode | null {
  const { ts } = extraction;
  for (const statement of module.sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  }
  const initializer = localInitializer(extraction, module, name);
  return initializer ? functionNode(ts, initializer) : null;
}

/** Inline actions: a `"use server"` directive inside a function body. Real
 * host surface, but not importable by the generated wiring — emitted disabled. */
function collectInlineActions(
  extraction: Extraction,
  module: FileModule,
  moduleRel: string,
  out: CollectedAction[],
): Promise<void> {
  const { ts } = extraction;
  const pending: Array<Promise<void>> = [];

  const inlineName = (node: FunctionNode): string | null => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      if (node.name) return node.name.text;
    }
    const parent = node.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (parent !== undefined && ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
      return parent.name.text;
    }
    return null;
  };

  const visit = (node: TS.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
        && node.body !== undefined && ts.isBlock(node.body) && hasDirective(ts, node.body.statements)) {
      const name = inlineName(node);
      if (name === null) {
        extraction.warnings.push(`server-actions: an anonymous inline server action in ${moduleRel} cannot be identified; it was skipped`);
      } else {
        pending.push((async () => {
          out.push({
            module,
            moduleRel,
            exportName: name,
            riskName: name,
            params: await actionParams(extraction, module, node),
            disabled: "inline",
          });
        })());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sf);
  return Promise.all(pending).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Extraction entry point
// ---------------------------------------------------------------------------

function inputSchemaFor(params: ActionParam[]): { inputSchema: Record<string, unknown>; note?: string } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const reasons: string[] = [];
  for (const param of params) {
    properties[param.name] = param.schema;
    if (param.required) required.push(param.name);
    if (param.reason !== undefined) reasons.push(param.reason);
  }
  return {
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    ...(reasons.length > 0
      ? { note: `input schema partially interpreted; permissive where unknown (${reasons.join("; ")})` }
      : {}),
  };
}

function bindingFor(action: CollectedAction): ServerActionBinding {
  return {
    kind: "server-action",
    module: action.moduleRel,
    exportName: action.exportName,
    params: action.params.map((param) => param.name),
  };
}

export async function extractServerActions(root: string): Promise<ServerActionsExtractResult> {
  const warnings: string[] = [];
  const ts = loadTypescript(root);
  if (!ts) {
    return {
      tools: [],
      warnings: ["server-actions extraction skipped: the TypeScript compiler could not be resolved from the host package"],
    };
  }
  const extraction: Extraction = { ts, root, modules: new Map(), warnings };

  const files = await walk(root, (relativePath) => {
    const posixPath = relativePath.split(path.sep).join("/");
    return SOURCE_FILE_PATTERN.test(posixPath) && !/\.d\.ts$/.test(posixPath) && !TEST_FILE_PATTERN.test(posixPath);
  });

  const actions: CollectedAction[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("use server")) continue;
    const module = parseModule(extraction, file, source);
    const moduleRel = path.relative(root, file).split(path.sep).join("/");
    if (isModuleLevelUseServer(ts, module.sf)) {
      await collectModuleActions(extraction, module, moduleRel, actions);
    } else {
      await collectInlineActions(extraction, module, moduleRel, actions);
    }
  }

  const tools: ExtractedTool[] = [];
  const usedNames = new Set<string>();
  const seen = new Set<string>();
  for (const action of actions) {
    const dedup = `${action.moduleRel}#${action.exportName}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    if (action.disabled === "unclassifiable") {
      const name = allocateToolName(serverActionToolFullName(action.riskName), "action", usedNames);
      tools.push({
        name,
        description: `server action ${action.moduleRel}#${action.exportName} could not be classified`,
        inputSchema: { type: "object", properties: {} },
        risk: "destructive",
        disabled: true,
        note: `${action.unclassifiableReason ?? "not statically classifiable"}; enable only after review; overrides.json can flip disabled/risk`,
        binding: bindingFor(action),
      });
      warnings.push(`server-actions: ${action.moduleRel}#${action.exportName} could not be classified: ${action.unclassifiableReason ?? "unknown"}`);
      continue;
    }

    const { inputSchema, note } = inputSchemaFor(action.params);
    const name = allocateToolName(serverActionToolFullName(action.riskName), "action", usedNames);
    const inline = action.disabled === "inline";
    const inlineNote = "inline server action (declared inside a component); the generated wiring cannot import it — hoist it into an exported \"use server\" module to enable; execution fails closed until then";
    tools.push({
      name,
      description: `server action ${action.moduleRel}#${action.exportName}`,
      inputSchema,
      risk: serverActionRisk(action.riskName),
      ...(inline
        ? { disabled: true, note: note === undefined ? inlineNote : `${inlineNote}; ${note}` }
        : note === undefined ? {} : { note }),
      binding: bindingFor(action),
    });
    if (inline) {
      warnings.push(`server-actions: inline action ${action.moduleRel}#${action.exportName} is not importable and was emitted disabled`);
    }
  }

  return { tools, warnings };
}
