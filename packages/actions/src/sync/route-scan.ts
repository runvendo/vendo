import { promises as fs } from "node:fs";
import path from "node:path";
import type TS from "typescript";
import type { ExtractedTool, HttpMethod } from "../formats.js";
import {
  allocateToolName,
  extractedRisk,
  importReferenceFor,
  parseModuleSource,
  resolveImportSource,
  routeToolFullName,
  unclassifiedToolFullName,
  visitNodes,
  walk,
  type ParsedModule,
} from "./common.js";
import { createRouteScanState, inferRouteInput, type RouteInputResult } from "./route-schema.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
const MAX_REEXPORT_DEPTH = 4;

interface RouteSource {
  file: string;
  urlPath: string;
  source: string;
  kind: "app" | "pages";
  catchAll: boolean;
}

interface ReExportTarget {
  specifier: string;
  assumeDefaultExport: boolean;
}

export interface RouteScanResult {
  tools: ExtractedTool[];
  warnings: string[];
}

function cleanSegment(segment: string): string | null {
  if ((segment.startsWith("(") && segment.endsWith(")")) || segment.startsWith("@")) return null;
  const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
  if (optionalCatchAll?.[1]) return `{${optionalCatchAll[1]}}`;
  const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
  if (catchAll?.[1]) return `{${catchAll[1]}}`;
  const dynamic = segment.match(/^\[([^\]]+)\]$/);
  if (dynamic?.[1]) return `{${dynamic[1]}}`;
  return segment;
}

function routeGroupName(segment: string): string | null {
  return segment.startsWith("(") && segment.endsWith(")") ? segment.slice(1, -1).toLowerCase() : null;
}

function pathFromSegments(segments: readonly string[]): string {
  const cleaned = segments.map(cleanSegment).filter((segment): segment is string => segment !== null && segment.length > 0);
  return `/${cleaned.join("/")}`.replace(/\/+/g, "/");
}

function appRoutePath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (!/^route\.(?:tsx?|jsx?)$/.test(parts.at(-1) ?? "")) return null;
  const appIndex = parts.findIndex((part) => part === "app");
  if (appIndex === -1) return null;
  const routeSegments = parts.slice(appIndex + 1, -1);
  const urlPath = pathFromSegments(routeSegments);
  const apiRoute = urlPath === "/api" || urlPath.startsWith("/api/") || routeSegments.some((segment) => routeGroupName(segment) === "api");
  return apiRoute ? urlPath : null;
}

function pagesRoutePath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const pagesIndex = parts.findIndex((part) => part === "pages");
  if (pagesIndex === -1 || parts[pagesIndex + 1] !== "api") return null;
  const file = parts.at(-1);
  if (!file || !/\.(?:tsx?|jsx?)$/.test(file) || /\.d\.ts$/.test(file) || /\.test\./.test(file)) return null;
  const last = file.replace(/\.(?:tsx?|jsx?)$/, "");
  if (last.startsWith("_")) return null;
  const routeSegments = [...parts.slice(pagesIndex + 1, -1), last];
  if (routeSegments.at(-1) === "index") routeSegments.pop();
  return pathFromSegments(routeSegments);
}

function routePath(relativePath: string): { kind: RouteSource["kind"]; urlPath: string } | null {
  const app = appRoutePath(relativePath);
  if (app) return { kind: "app", urlPath: app };
  const pages = pagesRoutePath(relativePath);
  return pages ? { kind: "pages", urlPath: pages } : null;
}

function isVendoRoute(urlPath: string): boolean {
  return urlPath === "/api/vendo" || urlPath.startsWith("/api/vendo/");
}

function addMethod(methods: Set<HttpMethod>, value: string | undefined): void {
  const method = value?.toUpperCase();
  if (method && HTTP_METHOD_SET.has(method)) methods.add(method as HttpMethod);
}

function calleeSimpleName(ts: typeof TS, expression: TS.CallExpression): string | null {
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function isStringLike(ts: typeof TS, node: TS.Node): node is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function hasModifier(ts: typeof TS, statement: TS.Statement, kind: TS.SyntaxKind): boolean {
  return ts.canHaveModifiers(statement) === true
    && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === kind);
}

function bindingNames(ts: typeof TS, name: TS.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(ts, element.name));
}

function isReqMethodAccess(ts: typeof TS, node: TS.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === "method"
    && ts.isIdentifier(node.expression)
    && node.expression.text === "req";
}

function allowHeaderVerbs(ts: typeof TS, methods: Set<HttpMethod>, call: TS.CallExpression): void {
  if (calleeSimpleName(ts, call) !== "setHeader") return;
  const [header, value] = call.arguments;
  if (!header || !value || !isStringLike(ts, header) || header.text.toLowerCase() !== "allow") return;
  if (isStringLike(ts, value)) {
    for (const part of value.text.split(",")) addMethod(methods, part.trim());
  } else if (ts.isArrayLiteralExpression(value)) {
    for (const element of value.elements) {
      if (isStringLike(ts, element)) addMethod(methods, element.text);
    }
  }
}

function exportedVerbs(module: ParsedModule, kind: RouteSource["kind"]): Set<HttpMethod> {
  const { ts, sf } = module;
  const methods = new Set<HttpMethod>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) {
      addMethod(methods, statement.name?.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(ts, declaration.name)) addMethod(methods, name);
      }
      continue;
    }
    // Local export lists: `export { handler as PATCH }` (re-export lists from
    // other modules are handled by reExportTargets).
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) addMethod(methods, element.name.text);
    }
  }
  if (kind === "pages") {
    visitNodes(ts, sf, (node) => {
      if (ts.isBinaryExpression(node)
        && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(node.operatorToken.kind)
        && isReqMethodAccess(ts, node.left)
        && isStringLike(ts, node.right)) {
        addMethod(methods, node.right.text);
      }
      if (ts.isCaseClause(node) && isStringLike(ts, node.expression)) addMethod(methods, node.expression.text);
      if (ts.isCallExpression(node)) {
        allowHeaderVerbs(ts, methods, node);
        if (calleeSimpleName(ts, node) === "NextAuth") {
          methods.add("GET");
          methods.add("POST");
        }
      }
    });
  }
  return methods;
}

function verbKeyedProperties(ts: typeof TS, literal: TS.ObjectLiteralExpression): Set<HttpMethod> {
  const methods = new Set<HttpMethod>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) addMethod(methods, name.text);
  }
  return methods;
}

function methodKeyObjectVerbs(module: ParsedModule): Set<HttpMethod> | null {
  const { ts, sf } = module;
  let found: Set<HttpMethod> | null = null;
  visitNodes(ts, sf, (node) => {
    if (found || !ts.isCallExpression(node) || calleeSimpleName(ts, node) !== "defaultHandler") return;
    const argument = node.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) return;
    const methods = verbKeyedProperties(ts, argument);
    if (methods.size > 0) found = methods;
  });
  return found;
}

function routeMapVerbs(module: ParsedModule, route: RouteSource): Set<HttpMethod> | null {
  const { ts, sf } = module;
  const entries: Array<{ method: string; entryPath: string }> = [];
  visitNodes(ts, sf, (node) => {
    if (!ts.isPropertyAssignment(node) || !ts.isStringLiteral(node.name)) return;
    const match = node.name.text.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S.*)$/);
    if (match) entries.push({ method: match[1]!, entryPath: match[2]! });
  });
  if (entries.length === 0) return null;
  const methods = new Set<HttpMethod>();
  const itemRoute = /\/\{[^}]+\}$/.test(route.urlPath);
  for (const entry of entries) {
    const rootEntry = entry.entryPath === "/";
    if (route.catchAll || (itemRoute ? !rootEntry : rootEntry)) addMethod(methods, entry.method);
  }
  return methods;
}

function defaultImportSpecifier(ts: typeof TS, sf: TS.SourceFile, localName: string): string | null {
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.importClause?.name?.text === localName) return statement.moduleSpecifier.text;
  }
  return null;
}

function delegateCallName(ts: typeof TS, sf: TS.SourceFile): string | null {
  let found: string | null = null;
  visitNodes(ts, sf, (node) => {
    if (found || !ts.isReturnStatement(node) || !node.expression) return;
    const returned = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
    if (!ts.isCallExpression(returned) || !ts.isIdentifier(returned.expression)) return;
    const [first, second] = returned.arguments;
    if (first && second && ts.isIdentifier(first) && first.text === "req" && ts.isIdentifier(second) && second.text === "res") {
      found = returned.expression.text;
    }
  });
  return found;
}

async function reExportTargets(module: ParsedModule, source: string): Promise<ReExportTarget[]> {
  const { ts, sf } = module;
  const targets: ReExportTarget[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (!clause) {
        targets.push({ specifier, assumeDefaultExport: false });
        continue;
      }
      if (!ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        if (element.name.text === "default") targets.push({ specifier, assumeDefaultExport: true });
        else if (HTTP_METHOD_SET.has(element.name.text)) targets.push({ specifier, assumeDefaultExport: false });
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      const specifier = defaultImportSpecifier(ts, sf, statement.expression.text);
      if (specifier) targets.push({ specifier, assumeDefaultExport: true });
    }
  }
  const delegate = delegateCallName(ts, sf);
  const delegateReference = delegate ? await importReferenceFor(source, delegate) : undefined;
  if (delegateReference) targets.push({ specifier: delegateReference.specifier, assumeDefaultExport: true });
  return targets;
}

function hasDefaultHandler(module: ParsedModule, assumed: boolean): boolean {
  if (assumed) return true;
  const { ts, sf } = module;
  return sf.statements.some((statement) =>
    ts.isExportAssignment(statement)
    || hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)
    || (ts.isExportDeclaration(statement) && Boolean(statement.moduleSpecifier)
      && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some((element) => element.name.text === "default")));
}

function isFunctionLike(ts: typeof TS, node: TS.Node): boolean {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

// True only when the module's default export is a function body this scan
// can actually see and has already walked above — a named function
// declaration (`export default function handler(...) {}`), an inline
// function/arrow expression (`export default (req, res) => {...}`), or a
// bare identifier that resolves to one of those declared in this same file
// (`function handler(...) {}\nexport default handler;`). It deliberately
// excludes a default export that is the *result of calling* something
// (`export default withReporting(handler)`) or an unresolved re-export: in
// both cases the real method evidence may live in code this scan never
// inspects, so guessing GET there would trade a safe unclassified fallback
// for a confident wrong answer.
function hasInlineDefaultFunctionBody(ts: typeof TS, sf: TS.SourceFile): boolean {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)) return true;
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const expression = statement.expression;
    if (isFunctionLike(ts, expression)) return true;
    if (!ts.isIdentifier(expression)) continue;
    const localName = expression.text;
    const declaresLocalFunction = sf.statements.some((candidate) => {
      if (ts.isFunctionDeclaration(candidate)) return candidate.name?.text === localName;
      if (!ts.isVariableStatement(candidate)) return false;
      return candidate.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === localName
        && declaration.initializer !== undefined && isFunctionLike(ts, declaration.initializer));
    });
    if (declaresLocalFunction) return true;
  }
  return false;
}

function inferredPageVerbs(module: ParsedModule, route: RouteSource, assumed = false): Set<HttpMethod> {
  const { ts, sf } = module;
  const methods = new Set<HttpMethod>();
  if (route.kind !== "pages" || !hasDefaultHandler(module, assumed)) return methods;

  let reqMethod = false;
  let reqBody = false;
  let handlerMap = false;
  let apiHandlers = false;
  let createNextApiHandlerCall = false;
  let handleUploadCall = false;
  let bodyParserDisabled = false;
  visitNodes(ts, sf, (node) => {
    if (isReqMethodAccess(ts, node)) reqMethod = true;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "body"
      && ts.isIdentifier(node.expression) && node.expression.text === "req") reqBody = true;
    if (ts.isIdentifier(node)) {
      if (node.text === "handlerMap") handlerMap = true;
      if (node.text === "apiHandlers") apiHandlers = true;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeSimpleName(ts, node);
      if (name === "createNextApiHandler") createNextApiHandlerCall = true;
      if (name === "handleUpload") handleUploadCall = true;
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && node.name.text === "bodyParser" && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
      bodyParserDisabled = true;
    }
  });

  if (reqMethod) return methods;
  if (createNextApiHandlerCall) {
    methods.add("GET");
    methods.add("POST");
  } else if (handlerMap && apiHandlers && route.catchAll) {
    methods.add("POST");
  } else if (handleUploadCall || reqBody) {
    methods.add("POST");
  } else if (bodyParserDisabled || route.urlPath.endsWith("/webhook")) {
    methods.add("POST");
  }
  // A default export whose function body this scan actually walked above,
  // with none of the write-shaped evidence found and no req.method branch
  // (checked earlier), is method-blind by construction: it answers every
  // verb identically. GET is the minimal truthful capability to claim for
  // it — the handler demonstrably serves GET, so leaving it unclassified
  // would be less honest, not more careful. Risk still falls out of
  // extractedRisk's route-source fail-closed rule (GET from a route never
  // earns "read"; it earns "write" here). The unclassified fallback remains
  // for routes where the default export is opaque — an unresolved re-export,
  // or a call to a wrapper whose body this scan never inspects (see
  // hasInlineDefaultFunctionBody) — because the real evidence may be hiding
  // in code we can't see, and guessing GET there would be a confident wrong
  // answer, not a minimal truthful one.
  if (methods.size === 0 && hasInlineDefaultFunctionBody(ts, sf)) methods.add("GET");
  return methods;
}

async function verbsFromSource(
  file: string,
  source: string,
  route: RouteSource,
  root: string,
  visited: Set<string>,
  depth: number,
  assumeDefaultExport: boolean,
): Promise<Set<HttpMethod>> {
  const key = `${file}\t${assumeDefaultExport ? "default" : "named"}`;
  if (visited.has(key)) return new Set();
  visited.add(key);
  const module = parseModuleSource(source, file);
  if (!module) return new Set();
  // A route file can mix evidence kinds (e.g. an inline GET plus a re-exported
  // POST), so union every source instead of returning the first non-empty one.
  const methods = exportedVerbs(module, route.kind);
  const mapped = routeMapVerbs(module, route);
  if (mapped) for (const method of mapped) methods.add(method);
  const objectMethods = methodKeyObjectVerbs(module);
  if (objectMethods) for (const method of objectMethods) methods.add(method);
  if (depth < MAX_REEXPORT_DEPTH) {
    for (const target of await reExportTargets(module, source)) {
      const resolved = await resolveImportSource(file, target.specifier, root);
      if (!resolved) continue;
      const nested = await verbsFromSource(
        resolved.file,
        resolved.source,
        route,
        root,
        visited,
        depth + 1,
        target.assumeDefaultExport,
      );
      for (const method of nested) methods.add(method);
    }
  }
  if (methods.size > 0) return methods;
  return inferredPageVerbs(module, route, assumeDefaultExport);
}

function routeInputSchema(urlPath: string): Record<string, unknown> {
  const params = [...urlPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).filter(Boolean);
  const unique = [...new Set(params)];
  return {
    type: "object",
    properties: Object.fromEntries(unique.map((param) => [param, { type: "string" }])),
    ...(unique.length > 0 ? { required: unique } : {}),
    additionalProperties: true,
  };
}

/**
 * Fold a collector's verdict (route-schema.ts) into the path-params-only
 * schema `routeInputSchema` always produces. `inferred === null` (no
 * collector recognized anything) reproduces today's exact output — the
 * fail-closed default. Otherwise: path params are kept, and a body schema
 * replaces the blank permissive default for body-bound methods.
 *
 * Query properties merge in ONLY for query-bound methods (`argsIn:
 * "query"`, GET/DELETE) — NOT "regardless of argsIn" as an earlier draft of
 * this comment claimed (review carry-over, PR 2 Task 4). The runtime
 * (`runtime/registry.ts`'s route execution, ~560-564) sends every non-path
 * argument as `searchParams` for a query-bound tool but as a single JSON
 * body for a body-bound tool — never split across both. Advertising a
 * query-derived property on a body-bound (POST/PUT/PATCH) tool would be a
 * lie: the runtime would deliver it in the JSON body, and the handler
 * (which reads it off `searchParams`) would never see it. `route-schema.ts`'s
 * query collector (Task 4) still runs unconditionally and still reports what
 * it finds for a body-bound route+method — this function is what drops
 * those findings before they reach the emitted tool. The drop is silent (no
 * `note`): it's a scope decision about where evidence is safe to surface,
 * not a recognition failure. Query-derived properties never join `required`
 * either way (fail-closed: absence of a query param is never proof it's
 * missing).
 *
 * Notes follow the SAME argsIn gate as the body schema they describe
 * (review carry-over, PR 2 Task 5). Every note a collector can produce
 * (`route-schema.ts`'s zod/checker collectors; the query collector never
 * sets one — Task 4) describes the BODY half of its verdict, so a note only
 * reaches the emitted tool when `body` above was actually populated — i.e.
 * `argsIn === "body"` AND the collector found something for the body. A note
 * attached to a query-bound (GET/DELETE) tool would describe a schema the
 * runtime never delivers to that handler (query args arrive via
 * `searchParams`, never a JSON body): surfacing it would misattribute
 * evidence the agent can't act on, exactly the same honesty problem the
 * query-properties gate above solves for properties. So it's dropped
 * silently, right alongside them.
 *
 * One case needs a note of its own, generated here rather than by a
 * collector: a RECOGNIZED but non-object top-level body schema — a route
 * whose entire body is validated as `z.array(...)` or cast to `string[]`,
 * not an object with properties — has no `properties`/`required` to fold
 * into the object-shaped schema every route tool emits. Silently falling
 * through the merge above (as it does today) reads identically to "no
 * evidence found," which is false: real evidence was found and is being
 * dropped only because it can't be represented on this tool shape. That
 * drop gets its own note, gated by the exact same argsIn rule as everything
 * else here — a body-bound method sees it (the schema, if representable,
 * would have described what the runtime actually delivers); a query-bound
 * method never merges a body schema in the first place, so it never earns
 * this note either.
 */
function mergeRouteInput(
  urlPath: string,
  argsIn: "query" | "body",
  inferred: RouteInputResult | null,
): { inputSchema: Record<string, unknown>; note?: string } {
  const base = routeInputSchema(urlPath);
  if (!inferred) return { inputSchema: base };

  const properties: Record<string, unknown> = { ...(base.properties as Record<string, unknown>) };
  const required = new Set<string>((base.required as string[] | undefined) ?? []);
  let additionalProperties = base.additionalProperties;
  let note: string | undefined;

  const body = argsIn === "body" ? inferred.bodySchema : undefined;
  if (body) {
    if (typeof body.type === "string" && body.type !== "object") {
      note = `recognized non-object body schema (${body.type}) cannot be represented on a route tool; permissive schema emitted`;
    } else {
      for (const [key, value] of Object.entries((body.properties as Record<string, unknown> | undefined) ?? {})) {
        properties[key] = value;
      }
      for (const key of (body.required as string[] | undefined) ?? []) required.add(key);
      if (typeof body.additionalProperties === "boolean") additionalProperties = body.additionalProperties;
      note = inferred.note;
    }
  }

  if (argsIn === "query" && inferred.queryProperties) {
    for (const [key, value] of Object.entries(inferred.queryProperties)) properties[key] = value;
  }

  return {
    inputSchema: {
      type: "object",
      properties,
      ...(required.size > 0 ? { required: [...required] } : {}),
      additionalProperties,
    },
    note,
  };
}

async function routeSources(root: string): Promise<RouteSource[]> {
  const files = await walk(root, (relativePath) => {
    const route = routePath(relativePath);
    return Boolean(route && !isVendoRoute(route.urlPath));
  });
  const sources: RouteSource[] = [];
  for (const file of files) {
    const relativePath = path.relative(root, file).replace(/\\/g, "/");
    const route = routePath(relativePath);
    if (!route || isVendoRoute(route.urlPath)) continue;
    sources.push({
      file,
      ...route,
      catchAll: /\[\[?\.\.\.[^\]]+\]\]?/.test(relativePath),
      source: await fs.readFile(file, "utf8"),
    });
  }
  return sources;
}

function preferredRoutes(routes: RouteSource[]): RouteSource[] {
  const ordered = [...routes].sort((left, right) =>
    left.urlPath.localeCompare(right.urlPath)
    || (left.kind === "app" ? 0 : 1) - (right.kind === "app" ? 0 : 1)
    || left.file.localeCompare(right.file));
  const byPath = new Map<string, RouteSource>();
  for (const route of ordered) if (!byPath.has(route.urlPath)) byPath.set(route.urlPath, route);
  return [...byPath.values()];
}

export async function scanRoutes(root: string): Promise<RouteScanResult> {
  const routes = preferredRoutes(await routeSources(root));
  const warnings: string[] = [];
  const tools: ExtractedTool[] = [];
  const usedNames = new Set<string>();
  const scanState = createRouteScanState(root, routes.map((route) => route.file));
  for (const route of routes) {
    const methods = await verbsFromSource(route.file, route.source, route, root, new Set(), 0, false);
    if (methods.size === 0) {
      const reason = route.kind === "pages"
        ? "pages handler has no supported HTTP method evidence"
        : "app route has no supported exported HTTP verb";
      const name = allocateToolName(unclassifiedToolFullName(route.urlPath), "POST", usedNames);
      tools.push({
        name,
        description: `Route ${route.urlPath} could not be classified`,
        inputSchema: { type: "object", properties: {} },
        risk: "destructive",
        disabled: true,
        note: `${reason}; enable only after review; overrides.json can flip disabled/risk`,
        binding: { kind: "route", method: "POST", path: route.urlPath, argsIn: "body" },
      });
      warnings.push(`route ${route.urlPath} could not be classified: ${reason}`);
      continue;
    }
    for (const method of HTTP_METHODS) {
      if (!methods.has(method)) continue;
      const preferred = routeToolFullName(method, route.urlPath);
      const name = allocateToolName(preferred, method, usedNames);
      const argsIn = method === "GET" || method === "DELETE" ? "query" : "body";
      const inferred = await inferRouteInput(route, method, scanState);
      const { inputSchema, note } = mergeRouteInput(route.urlPath, argsIn, inferred);
      tools.push({
        name,
        description: `${method} ${route.urlPath}`,
        inputSchema,
        risk: extractedRisk(method, name, "route"),
        ...(note ? { note } : {}),
        binding: {
          kind: "route",
          method,
          path: route.urlPath,
          argsIn,
        },
      });
    }
  }
  // The checker collector (route-schema.ts) can only fail closed at
  // scan-level granularity (e.g. "no tsconfig.json found") — it has no single
  // tool to attach that warning to, so it queues it on the shared scan state
  // instead; drain it here into route-scan's own warnings output.
  warnings.push(...scanState.warnings);
  return { tools, warnings };
}
