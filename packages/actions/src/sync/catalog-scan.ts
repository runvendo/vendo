import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonSchema } from "@vendoai/core";
import type tsTypes from "typescript";
import type { CatalogEntry } from "../formats.js";
import { walk } from "./common.js";

let ts: typeof tsTypes;

async function loadTypeScript(): Promise<typeof tsTypes> {
  return (await import("typescript")).default;
}

export interface CatalogScanResult {
  entries: CatalogEntry[];
  warnings: string[];
  discovered: number;
  registered: number;
}

interface ComponentCandidate {
  name: string;
  declaration: tsTypes.FunctionLikeDeclaration;
  exportPath: string;
}

interface SchemaResult {
  schema?: JsonSchema;
  unsupported?: string;
}

const PASCAL_CASE = /^[A-Z][A-Za-z0-9_$]*$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function vendoRootNames(sourceFile: tsTypes.SourceFile): Set<string> {
  const names = new Set(["VendoRoot"]);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@vendoai/vendo/react"
      || statement.importClause?.namedBindings === undefined
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === "VendoRoot") names.add(element.name.text);
    }
  }
  return names;
}

function isVendoRootTag(tagName: tsTypes.JsxTagNameExpression, names: ReadonlySet<string>): boolean {
  const text = tagName.getText();
  return names.has(text) || text.slice(text.lastIndexOf(".") + 1) === "VendoRoot";
}

function hasJsxEvidence(node: tsTypes.Node): boolean {
  let found = false;
  const visit = (child: tsTypes.Node): void => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function unwrapExpression(expression: tsTypes.Expression): tsTypes.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function functionFromDeclaration(declaration: tsTypes.Declaration | undefined): tsTypes.FunctionLikeDeclaration | undefined {
  if (declaration === undefined) return undefined;
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  }
  return undefined;
}

function symbolDeclaration(checker: tsTypes.TypeChecker, expression: tsTypes.Expression): tsTypes.Declaration | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const symbol = resolvedSymbol(checker, unwrapped);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function resolvedSymbol(checker: tsTypes.TypeChecker, node: tsTypes.Node): tsTypes.Symbol | undefined {
  let symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function registeredComponentMaps(
  program: tsTypes.Program,
  checker: tsTypes.TypeChecker,
  root: string,
  warnings: string[],
): Set<tsTypes.Symbol> {
  const registered = new Set<tsTypes.Symbol>();
  for (const sourceFile of program.getSourceFiles()) {
    const relative = path.relative(root, sourceFile.fileName);
    if (sourceFile.isDeclarationFile || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const rootNames = vendoRootNames(sourceFile);
    const visit = (node: tsTypes.Node): void => {
      if (ts.isJsxAttribute(node)
        && ts.isIdentifier(node.name)
        && node.name.text === "components") {
        const opening = node.parent.parent;
        if ((ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))
          && isVendoRootTag(opening.tagName, rootNames)) {
          const expression = node.initializer !== undefined
            && ts.isJsxExpression(node.initializer)
            && node.initializer.expression !== undefined
            ? unwrapExpression(node.initializer.expression)
            : undefined;
          if (expression !== undefined && ts.isIdentifier(expression)) {
            const symbol = resolvedSymbol(checker, expression);
            if (symbol !== undefined) registered.add(symbol);
          } else {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            warnings.push(
              `component catalog ignored inline components map at ${relativeModulePath(root, sourceFile.fileName)}:${line}; export a named component map and pass that identifier to VendoRoot`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return registered;
}

function propertyName(name: tsTypes.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function objectField(object: tsTypes.ObjectLiteralExpression, name: string): tsTypes.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return undefined;
}

function localConstants(sourceFile: tsTypes.SourceFile): Map<string, tsTypes.Expression> {
  const constants = new Map<string, tsTypes.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return constants;
}

function resolvedLocalExpression(constants: Map<string, tsTypes.Expression>, expression: tsTypes.Expression): tsTypes.Expression {
  let current = unwrapExpression(expression);
  const seen = new Set<string>();
  while (ts.isIdentifier(current)) {
    if (seen.has(current.text)) break;
    seen.add(current.text);
    const initializer = constants.get(current.text);
    if (initializer === undefined) break;
    current = unwrapExpression(initializer);
  }
  return current;
}

function localConstantJson(constants: Map<string, tsTypes.Expression>, expression: tsTypes.Expression, depth = 0): unknown {
  if (depth > 20) return undefined;
  const value = resolvedLocalExpression(constants, expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    return value.operator === ts.SyntaxKind.MinusToken ? -number : number;
  }
  if (ts.isArrayLiteralExpression(value)) {
    const array: unknown[] = [];
    for (const element of value.elements) {
      if (ts.isSpreadElement(element)) return undefined;
      const item = localConstantJson(constants, element, depth + 1);
      if (item === undefined) return undefined;
      array.push(item);
    }
    return array;
  }
  if (ts.isObjectLiteralExpression(value)) {
    const object: Record<string, unknown> = {};
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = propertyName(property.name);
      const item = localConstantJson(constants, property.initializer, depth + 1);
      if (name === undefined || item === undefined) return undefined;
      object[name] = item;
    }
    return object;
  }
  if (ts.isPropertyAccessExpression(value) && value.name.text === "options") {
    const target = resolvedLocalExpression(constants, value.expression);
    if (ts.isCallExpression(target)
      && ts.isPropertyAccessExpression(target.expression)
      && target.expression.name.text === "enum"
      && target.arguments[0] !== undefined) {
      return localConstantJson(constants, target.arguments[0], depth + 1);
    }
  }
  return undefined;
}

async function registeredCatalogEntries(
  registrationFiles: string[],
  root: string,
  scanned: Map<string, CatalogEntry>,
  warnings: string[],
): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const file of registrationFiles) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const constants = localConstants(sourceFile);
    const modulePath = relativeModulePath(root, file);
    const visit = (node: tsTypes.Node): void => {
      if (!ts.isCallExpression(node)
        || !ts.isIdentifier(node.expression)
        || node.expression.text !== "createVendo"
        || node.arguments[0] === undefined) {
        ts.forEachChild(node, visit);
        return;
      }
      const config = resolvedLocalExpression(constants, node.arguments[0]);
      if (!ts.isObjectLiteralExpression(config)) return;
      const catalogExpression = objectField(config, "catalog");
      if (catalogExpression === undefined) return;
      const catalog = resolvedLocalExpression(constants, catalogExpression);
      if (!ts.isArrayLiteralExpression(catalog)) {
        warnings.push(`registered component catalog in ${modulePath} is not a statically resolvable array; scanned entries remain authoritative`);
        return;
      }
      for (const element of catalog.elements) {
        if (ts.isSpreadElement(element)) continue;
        const rawEntry = resolvedLocalExpression(constants, element);
        if (!ts.isObjectLiteralExpression(rawEntry)) continue;
        const name = localConstantJson(constants, objectField(rawEntry, "name") ?? rawEntry) as unknown;
        const description = localConstantJson(constants, objectField(rawEntry, "description") ?? rawEntry) as unknown;
        const propsJsonSchema = localConstantJson(constants, objectField(rawEntry, "propsJsonSchema") ?? rawEntry) as unknown;
        const rawExamples = objectField(rawEntry, "examples");
        const examples = rawExamples === undefined ? undefined : localConstantJson(constants, rawExamples);
        if (typeof name !== "string" || !PASCAL_CASE.test(name)
          || typeof description !== "string"
          || propsJsonSchema === null
          || typeof propsJsonSchema !== "object"
          || Array.isArray(propsJsonSchema)
          || (examples !== undefined && (!Array.isArray(examples) || examples.some((example) => typeof example !== "string")))) {
          warnings.push(`registered component in ${modulePath} could not be serialized deterministically and was omitted`);
          continue;
        }
        if (seen.has(name)) {
          warnings.push(`registered component ${name} appears more than once; kept the first registration`);
          continue;
        }
        seen.add(name);
        entries.push({
          name,
          exportPath: scanned.get(name)?.exportPath ?? `${modulePath}#catalog.${name}`,
          propsSchema: propsJsonSchema as Record<string, unknown>,
          description,
          ...(examples === undefined ? {} : { examples: examples as string[] }),
          source: "registered",
        });
      }
    };
    visit(sourceFile);
  }
  return entries.sort((left, right) => compareText(left.name, right.name));
}

function exportedObjectCandidates(
  checker: tsTypes.TypeChecker,
  declaration: tsTypes.Declaration | undefined,
  modulePath: string,
  exportName: string,
): ComponentCandidate[] {
  if (declaration === undefined) return [];
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return [];
  const initializer = unwrapExpression(declaration.initializer);
  if (!ts.isObjectLiteralExpression(initializer)) return [];
  const candidates: ComponentCandidate[] = [];
  for (const property of initializer.properties) {
    let name: string | undefined;
    let value: tsTypes.Expression | undefined;
    if (ts.isPropertyAssignment(property)) {
      name = propertyName(property.name);
      value = property.initializer;
    } else if (ts.isShorthandPropertyAssignment(property)) {
      name = property.name.text;
      value = property.name;
    }
    if (name === undefined || value === undefined || !PASCAL_CASE.test(name)) continue;
    const component = functionFromDeclaration(symbolDeclaration(checker, value));
    if (component !== undefined && hasJsxEvidence(component)) {
      candidates.push({ name, declaration: component, exportPath: `${modulePath}#${exportName}.${name}` });
    }
  }
  return candidates;
}

function literalValue(type: tsTypes.Type): string | number | boolean | undefined {
  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return (type as tsTypes.Type & { intrinsicName?: string }).intrinsicName === "true";
  }
  return undefined;
}

function withoutUndefined(type: tsTypes.Type): tsTypes.Type[] {
  const members = type.isUnion() ? type.types : [type];
  return members.filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0);
}

function schemaForType(
  checker: tsTypes.TypeChecker,
  type: tsTypes.Type,
  location: tsTypes.Node,
  seen: Set<number>,
  depth: number,
): SchemaResult {
  if (depth > 12) return { unsupported: `type nesting exceeds the supported depth (${checker.typeToString(type)})` };
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) {
    return { unsupported: `unsupported type ${checker.typeToString(type)}` };
  }

  const members = withoutUndefined(type);
  if (members.length !== (type.isUnion() ? type.types.length : 1)) {
    if (members.length === 0) return { unsupported: `unsupported type ${checker.typeToString(type)}` };
    if (members.length === 1) return schemaForType(checker, members[0]!, location, seen, depth);
    if (members.every((member) => (member.flags & ts.TypeFlags.BooleanLiteral) !== 0)) {
      return { schema: { type: "boolean" } };
    }
    const values = members.map(literalValue);
    if (values.every((value) => value !== undefined)) return { schema: { enum: values } };
    const variants: JsonSchema[] = [];
    for (const member of members) {
      const converted = schemaForType(checker, member, location, new Set(seen), depth + 1);
      if (converted.schema === undefined) return converted;
      variants.push(converted.schema);
    }
    return { schema: { anyOf: variants } };
  }

  if (type.isUnion()) {
    if (type.types.every((member) => (member.flags & ts.TypeFlags.BooleanLiteral) !== 0)) {
      return { schema: { type: "boolean" } };
    }
    const values = type.types.map(literalValue);
    if (values.every((value) => value !== undefined)) return { schema: { enum: values } };
    const variants: JsonSchema[] = [];
    for (const member of type.types) {
      const converted = schemaForType(checker, member, location, new Set(seen), depth + 1);
      if (converted.schema === undefined) return converted;
      variants.push(converted.schema);
    }
    return { schema: { anyOf: variants } };
  }

  const literal = literalValue(type);
  if (literal !== undefined) return { schema: { const: literal } };
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { schema: { type: "string" } };
  if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0) return { schema: { type: "number" } };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { schema: { type: "boolean" } };
  if ((type.flags & ts.TypeFlags.Null) !== 0) return { schema: { type: "null" } };

  if (checker.isTupleType(type)) {
    const arguments_ = checker.getTypeArguments(type as tsTypes.TypeReference);
    const prefixItems: JsonSchema[] = [];
    for (const argument of arguments_) {
      const converted = schemaForType(checker, argument, location, new Set(seen), depth + 1);
      if (converted.schema === undefined) return converted;
      prefixItems.push(converted.schema);
    }
    return { schema: { type: "array", prefixItems, minItems: prefixItems.length, maxItems: prefixItems.length } };
  }
  if (checker.isArrayType(type)) {
    const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (item === undefined) return { unsupported: `array item type could not be resolved (${checker.typeToString(type)})` };
    const converted = schemaForType(checker, item, location, new Set(seen), depth + 1);
    return converted.schema === undefined ? converted : { schema: { type: "array", items: converted.schema } };
  }

  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return { unsupported: `callable type ${checker.typeToString(type)}` };
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return { unsupported: `unsupported type ${checker.typeToString(type)}` };
  }

  const id = (type as tsTypes.Type & { id?: number }).id;
  if (id !== undefined) {
    if (seen.has(id)) return { unsupported: `recursive type ${checker.typeToString(type)}` };
    seen.add(id);
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const property of checker.getPropertiesOfType(type).sort((left, right) => compareText(left.name, right.name))) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const converted = schemaForType(checker, propertyType, declaration, new Set(seen), depth + 1);
    if (converted.schema === undefined) {
      return { unsupported: `property ${property.name} uses ${converted.unsupported ?? checker.typeToString(propertyType)}` };
    }
    properties[property.name] = converted.schema;
    if ((property.flags & ts.SymbolFlags.Optional) === 0
      && withoutUndefined(propertyType).length === (propertyType.isUnion() ? propertyType.types.length : 1)) {
      required.push(property.name);
    }
  }

  const schema: JsonSchema = { type: "object", properties };
  const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (stringIndex === undefined) schema.additionalProperties = false;
  else {
    const converted = schemaForType(checker, stringIndex, location, new Set(seen), depth + 1);
    if (converted.schema === undefined) return converted;
    schema.additionalProperties = converted.schema;
  }
  if (required.length > 0) schema.required = required;
  return { schema };
}

function schemaForComponent(checker: tsTypes.TypeChecker, declaration: tsTypes.FunctionLikeDeclaration): SchemaResult {
  const signature = checker.getSignatureFromDeclaration(declaration as tsTypes.SignatureDeclaration);
  const parameter = signature?.parameters[0];
  if (parameter === undefined) {
    return { schema: { type: "object", properties: {}, additionalProperties: false } };
  }
  const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? declaration;
  return schemaForType(
    checker,
    checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
    parameterDeclaration,
    new Set(),
    0,
  );
}

function relativeModulePath(root: string, fileName: string): string {
  const relative = path.relative(root, fileName).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function programFor(root: string, rootNames: string[]): { program?: tsTypes.Program; warnings: string[] } {
  const warnings: string[] = [];
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) return { warnings: ["component catalog scan skipped: no tsconfig.json found"] };
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    return { warnings: [`component catalog scan skipped: ${ts.flattenDiagnosticMessageText(config.error.messageText, " ")}`] };
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
  for (const diagnostic of parsed.errors) {
    warnings.push(`component catalog tsconfig: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  if (rootNames.length === 0) return { warnings };
  const options: tsTypes.CompilerOptions = { ...parsed.options, types: [] };
  const host = ts.createCompilerHost(options);
  const cache = ts.createModuleResolutionCache(root, host.getCanonicalFileName, options);
  host.resolveModuleNameLiterals = (moduleLiterals, containingFile) => moduleLiterals.map((literal) => {
    const pathMapped = Object.keys(options.paths ?? {}).some((pattern) => {
      const star = pattern.indexOf("*");
      return star === -1
        ? literal.text === pattern
        : literal.text.startsWith(pattern.slice(0, star)) && literal.text.endsWith(pattern.slice(star + 1));
    });
    if (!literal.text.startsWith(".") && !pathMapped) return { resolvedModule: undefined };
    const resolution = ts.resolveModuleName(literal.text, containingFile, options, host, cache).resolvedModule;
    if (resolution === undefined) return { resolvedModule: undefined };
    const relative = path.relative(root, resolution.resolvedFileName);
    const isHostSource = !relative.startsWith("..") && !path.isAbsolute(relative);
    return { resolvedModule: isHostSource ? resolution : undefined };
  });
  return { program: ts.createProgram({ rootNames, options, host }), warnings };
}

function sourceCatalogEvidence(sourceFile: tsTypes.SourceFile): { component: boolean; registration: boolean } {
  let component = false;
  let registration = false;
  const rootNames = vendoRootNames(sourceFile);
  const visit = (node: tsTypes.Node): void => {
    if (ts.isJsxAttribute(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "components"
      && (ts.isJsxOpeningElement(node.parent.parent) || ts.isJsxSelfClosingElement(node.parent.parent))
      && isVendoRootTag(node.parent.parent.tagName, rootNames)) {
      component = true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createVendo") {
      registration = true;
    }
    if (!component || !registration) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { component, registration };
}

async function catalogEvidenceFiles(files: string[]): Promise<{ componentFiles: string[]; registrationFiles: string[] }> {
  const componentFiles: string[] = [];
  const registrationFiles: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const evidence = sourceCatalogEvidence(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind));
    if (evidence.component) componentFiles.push(file);
    if (evidence.registration) registrationFiles.push(file);
  }
  return { componentFiles, registrationFiles };
}

/** Deterministic TypeScript-compiler scan. No model output can alter these fields. */
export async function scanComponentCatalog(root: string): Promise<CatalogScanResult> {
  const resolvedRoot = path.resolve(root);
  const sourceFiles = await walk(resolvedRoot, (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.d\.ts$/.test(relative));
  if (sourceFiles.length === 0) return { entries: [], warnings: [], discovered: 0, registered: 0 };
  try {
    ts = await loadTypeScript();
  } catch (error) {
    return {
      entries: [],
      warnings: [`component catalog scan skipped: TypeScript compiler unavailable; install typescript for sync-time extraction (${error instanceof Error ? error.message : String(error)})`],
      discovered: 0,
      registered: 0,
    };
  }
  const evidenceFiles = await catalogEvidenceFiles(sourceFiles);
  if (evidenceFiles.componentFiles.length === 0 && evidenceFiles.registrationFiles.length === 0) {
    return { entries: [], warnings: [], discovered: 0, registered: 0 };
  }
  const candidates: ComponentCandidate[] = [];
  const configured = programFor(resolvedRoot, evidenceFiles.componentFiles);
  const warnings = [...configured.warnings];
  const checker = configured.program?.getTypeChecker();
  if (configured.program !== undefined && checker !== undefined) {
    const componentMaps = registeredComponentMaps(configured.program, checker, resolvedRoot, warnings);
    for (const sourceFile of configured.program.getSourceFiles()) {
      const relative = path.relative(resolvedRoot, sourceFile.fileName);
      if (sourceFile.isDeclarationFile || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (relative.split(path.sep).some((part) => part === "node_modules" || part === "dist" || part.startsWith("."))) continue;
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol === undefined) continue;
      const modulePath = relativeModulePath(resolvedRoot, sourceFile.fileName);
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        let target = exported;
        if ((target.flags & ts.SymbolFlags.Alias) !== 0) target = checker.getAliasedSymbol(target);
        const declaration = target.valueDeclaration ?? target.declarations?.[0];
        if (componentMaps.has(target)) {
          candidates.push(...exportedObjectCandidates(checker, declaration, modulePath, exported.name));
        }
      }
    }
  }

  candidates.sort((left, right) => compareText(left.name, right.name) || compareText(left.exportPath, right.exportPath));
  const scannedEntries: CatalogEntry[] = [];
  const seen = new Set<string>();
  if (checker !== undefined) {
    for (const candidate of candidates) {
      if (seen.has(candidate.name)) {
        warnings.push(`component ${candidate.name} was discovered more than once; kept ${scannedEntries.find((entry) => entry.name === candidate.name)?.exportPath}`);
        continue;
      }
      seen.add(candidate.name);
      const converted = schemaForComponent(checker, candidate.declaration);
      scannedEntries.push({
        name: candidate.name,
        exportPath: candidate.exportPath,
        propsSchema: converted.schema ?? {},
        description: "",
        source: "scanned",
        ...(converted.unsupported === undefined
          ? {}
          : { note: `Props schema is permissive because the TypeScript type could not be represented deterministically: ${converted.unsupported}.` }),
      });
    }
  }
  const scannedByName = new Map(scannedEntries.map((entry) => [entry.name, entry]));
  const registeredEntries = await registeredCatalogEntries(evidenceFiles.registrationFiles, resolvedRoot, scannedByName, warnings);
  const registeredNames = new Set(registeredEntries.map((entry) => entry.name));
  const entries = [
    ...scannedEntries.filter((entry) => !registeredNames.has(entry.name)),
    ...registeredEntries,
  ].sort((left, right) => compareText(left.name, right.name));
  return { entries, warnings, discovered: scannedEntries.length, registered: registeredEntries.length };
}
