import path from "node:path";
import type TS from "typescript";
import type { HttpMethod } from "../formats.js";
import {
  MAX_RESOLVE_DEPTH,
  PERMISSIVE_INPUT,
  loadTypescript,
  parseModule,
  zodFromExpression,
  type FileModule,
  type StaticExtraction,
} from "./static-ts.js";

/**
 * Route-scan input-schema inference (PR 2, 04 §1): a collector seam asked
 * once per (route, method) at route-scan's single emission point. Collector
 * order (spec-locked): zod-in-handler first (Task 2, reuses the
 * oracle-hardened `zodFromExpression` from `static-ts.ts`), then the
 * TypeScript-checker collector (Task 3, one lazily built `ts.Program` per
 * scan), with the query collector (Task 4) merging additively into whichever
 * of those two results comes back. Every collector fails closed: no
 * recognizable evidence means `null`, and route-scan emits exactly what it
 * emits today (path params only, blank body/query). Task 2 (zod-in-handler)
 * and Task 3 (TypeScript checker, this module's second half) are wired below;
 * Task 4 (query) still returns nothing.
 */

/** The minimal route facts a collector needs. A structural subset of
 * route-scan's internal `RouteSource` — this module never imports from
 * route-scan.ts, so collectors stay one-directional (asked, never asking
 * back). */
export interface RouteContext {
  file: string;
  source: string;
  urlPath: string;
  kind: "app" | "pages";
}

/**
 * State shared across every `inferRouteInput` call within one `scanRoutes`
 * pass — created once per scan by `createRouteScanState`, then threaded
 * through unchanged call to call. `zodExtraction` is the zod collector's
 * `StaticExtraction` (module parse cache), built lazily on first need and
 * reused for every subsequent (route, method) so each route file is parsed at
 * most once per scan even though it is asked about once per HTTP method;
 * `undefined` means "not attempted yet", `null` means "the host's TypeScript
 * compiler could not be resolved" (cached so we do not retry every call).
 *
 * `routeFiles` is every route file discovered by this scan (route-scan.ts
 * hands the full list to `createRouteScanState` up front, before the
 * per-route loop) — the checker collector's `ts.Program` needs every route
 * file present as a root from the moment it is built, since the program is
 * constructed exactly once and never rebuilt mid-scan (04 §1 Task 3). `checkerProgram`/
 * `checkerTs` follow the same lazy-build-then-cache shape as `zodExtraction`;
 * `checkerProgramBuilds` counts how many times the program-construction path
 * actually ran (0 or 1 per scan — an injectable/inspectable counter the tests
 * use to assert the program is built at most once, and never when the zod
 * collector already answered). `warnings` collects scan-level messages (e.g.
 * "no tsconfig.json found") the checker collector can't attach to a single
 * tool; route-scan.ts drains this into its own returned `warnings` array.
 */
export interface RouteScanState {
  root: string;
  routeFiles: readonly string[];
  zodExtraction?: StaticExtraction | null;
  checkerProgram?: TS.Program | null;
  checkerTs?: typeof TS | null;
  checkerProgramBuilds: number;
  warnings: string[];
}

export function createRouteScanState(root: string, routeFiles: readonly string[] = []): RouteScanState {
  return { root, routeFiles, checkerProgramBuilds: 0, warnings: [] };
}

/** The zod collector's `StaticExtraction`, built once per scan (cached on
 * `state`) and shared across every route+method call so cross-file validator
 * resolution (`resolveIdentifier`) reuses the same module cache. Returns
 * `null`, cached, when the host's TypeScript compiler cannot be resolved. */
function zodExtractionFor(state: RouteScanState): StaticExtraction | null {
  if (state.zodExtraction !== undefined) return state.zodExtraction;
  const ts = loadTypescript(state.root);
  state.zodExtraction = ts ? { ts, root: state.root, modules: new Map() } : null;
  return state.zodExtraction;
}

/**
 * One collector's verdict for a route+method's input, additive by design:
 * `bodySchema` / `queryProperties` are undefined when that collector found
 * nothing for that half of the tool's args, and `note` carries a fail-closed
 * reason onto the emitted tool exactly like the tRPC/server-actions
 * extractors do for partially- or un-recognized shapes (04 §1).
 */
export interface RouteInputResult {
  bodySchema?: Record<string, unknown>;
  queryProperties?: Record<string, unknown>;
  note?: string;
}

/**
 * Ask every collector (spec-locked order) for `route`'s `method` input.
 * Returns `null` when nothing is recognized, so route-scan falls back to
 * today's exact path-params-only emission (fail-closed, byte-identical).
 * The zod collector runs first (a validator is stronger evidence than a
 * bare type) and short-circuits: the checker collector below is never even
 * asked when zod already answered, so its `ts.Program` is never built for a
 * handler zod already covers. Task 4 (query) still returns nothing and lands
 * in a later commit.
 */
export async function inferRouteInput(
  route: RouteContext,
  method: HttpMethod,
  state: RouteScanState,
): Promise<RouteInputResult | null> {
  const zodResult = await zodCollector(route, method, state);
  if (zodResult) return zodResult;
  return checkerCollector(route, method, state);
}

// ---------------------------------------------------------------------------
// Task 2: zod-in-handler collector
// ---------------------------------------------------------------------------

/** True when `statement` carries an `export` modifier. */
function hasExportKeyword(ts: typeof TS, statement: TS.Statement): boolean {
  return ts.canHaveModifiers(statement) === true
    && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** The handler function body for `method`, when the route module exports it
 * directly as a named function declaration or a const arrow/function
 * expression. Route files may re-export handlers from other modules or
 * delegate through pages-router default handlers — those shapes are
 * route-scan.ts's job (verb discovery), not this collector's; a same-file
 * named export is the only shape the zod collector looks inside, and it fails
 * closed (returns `null`, no handler body to search) for everything else. */
function methodHandlerBody(module: FileModule, ts: typeof TS, method: HttpMethod): TS.Node | null {
  for (const statement of module.sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === method
      && hasExportKeyword(ts, statement) && statement.body) {
      return statement.body;
    }
    if (ts.isVariableStatement(statement) && hasExportKeyword(ts, statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== method || !declaration.initializer) continue;
        const init = declaration.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
      }
    }
  }
  return null;
}

/** Peel wrapper layers off a `.parse`/`.safeParse` argument that do not change
 * *what* is being read, only how it's typed or guarded: `await`, redundant
 * parens, `as`/`satisfies` casts, non-null assertions, and a trailing
 * `.catch(...)` fallback (demo-bank's own handlers read
 * `(await req.json().catch(() => ({}))) as T` — apps/demo-bank's orders
 * route). Peeling `.catch`'s receiver, not its whole call, is what lets the
 * loop reach the underlying `.json()` call under any combination of the above. */
function unwrapJsonCandidate(ts: typeof TS, node: TS.Node): TS.Node {
  let current: TS.Node = node;
  for (;;) {
    if (ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "catch") {
      current = current.expression.expression;
    } else {
      return current;
    }
  }
}

/** True for an (unwrapped) `<x>.json()` call — the request-body read the zod
 * collector looks for as a `.parse`/`.safeParse` argument, per the plan's
 * "argument CONTAINING await x.json()" (04 §1 Task 2). */
function isJsonReadExpression(ts: typeof TS, node: TS.Node): boolean {
  const inner = unwrapJsonCandidate(ts, node);
  return ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "json";
}

/** One-hop local resolution (review-decided, no data-flow analysis): when the
 * `.parse`/`.safeParse` argument is a plain identifier — the two-statement
 * form `const body = await req.json(); schema.parse(body)` — look for a
 * `const`/`let` declaration of that name at the top level of the SAME
 * function body and test its initializer instead. Anything else (a different
 * scope, no matching declaration, an initializer that isn't a json read)
 * fails closed: not a match. */
function localDeclarationInitializer(ts: typeof TS, functionBody: TS.Node, name: string): TS.Expression | null {
  if (!ts.isBlock(functionBody)) return null;
  for (const statement of functionBody.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function isJsonBodyArgument(ts: typeof TS, argument: TS.Expression, functionBody: TS.Node): boolean {
  if (isJsonReadExpression(ts, argument)) return true;
  if (!ts.isIdentifier(argument)) return false;
  const initializer = localDeclarationInitializer(ts, functionBody, argument.text);
  return initializer !== null && isJsonReadExpression(ts, initializer);
}

/** The first `.parse`/`.safeParse` call in `body` whose argument reads the
 * request body — first match wins (spec-locked: a handler validating more
 * than once picks the first read in source order). Returns the callee's
 * receiver expression (the schema construction/reference), not the call
 * itself. */
function findZodParseReceiver(ts: typeof TS, body: TS.Node): TS.Expression | null {
  let found: TS.Expression | null = null;
  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "parse" || node.expression.name.text === "safeParse")) {
      const argument = node.arguments[0];
      if (argument && isJsonBodyArgument(ts, argument, body)) {
        found = node.expression.expression;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** The `{name}` path-param segments in a route's `urlPath`. */
function pathParamNames(urlPath: string): Set<string> {
  return new Set([...urlPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).filter((name): name is string => Boolean(name)));
}

/** Review carry-over: a body property sharing a name with a path param would
 * clobber the param's schema when route-scan.ts merges body properties over
 * path params (route-scan.ts's `mergeRouteInput`) — excluded here so the
 * collector never hands back a colliding property in the first place. */
function excludePathParams(schema: Record<string, unknown>, urlPath: string): Record<string, unknown> {
  const params = pathParamNames(urlPath);
  const properties = schema.properties;
  if (params.size === 0 || !properties || typeof properties !== "object") return schema;
  const filteredProperties = Object.fromEntries(
    Object.entries(properties as Record<string, unknown>).filter(([key]) => !params.has(key)),
  );
  const result: Record<string, unknown> = { ...schema, properties: filteredProperties };
  if (Array.isArray(schema.required)) {
    const filteredRequired = (schema.required as string[]).filter((key) => !params.has(key));
    if (filteredRequired.length > 0) result.required = filteredRequired;
    else delete result.required;
  }
  return result;
}

async function zodCollector(
  route: RouteContext,
  method: HttpMethod,
  state: RouteScanState,
): Promise<RouteInputResult | null> {
  const extraction = zodExtractionFor(state);
  if (!extraction) return null;
  const module = parseModule(extraction, route.file, route.source);
  const body = methodHandlerBody(module, extraction.ts, method);
  if (!body) return null;
  const receiver = findZodParseReceiver(extraction.ts, body);
  if (!receiver) return null;

  const interpreted = await zodFromExpression(extraction, module, receiver, 0);
  const bodySchema = interpreted.recognized ? interpreted.schema : { ...PERMISSIVE_INPUT };
  const note = interpreted.recognized
    ? interpreted.reason
      ? `input schema partially interpreted; permissive where unknown (${interpreted.reason})`
      : undefined
    : `input schema not statically interpreted (${interpreted.reason ?? "unrecognized validator"}); permissive schema emitted`;

  return { bodySchema: excludePathParams(bodySchema, route.urlPath), ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// Task 3: TypeScript-checker collector
// ---------------------------------------------------------------------------

/**
 * Build (or return the cached) `ts.Program` for the checker collector. Built
 * exactly once per scan, on first need (the first route+method with a
 * cast/annotation candidate the zod collector didn't already resolve — see
 * `checkerCollector`'s cheap syntactic pre-check, which is what keeps this
 * from ever running for a route with no such evidence), and reused unchanged
 * for every remaining call — `state.checkerProgramBuilds` counts how many
 * times this function's build path actually ran, so tests can assert "at
 * most once per scan" and "never, when zod already answered" without timing.
 *
 * Host resolution mirrors `catalog-scan.ts`'s `programFor` (the existing
 * compiler-API precedent in this package): the host's `tsconfig.json` is
 * required (`ts.findConfigFile`/`readConfigFile`) — a route-heavy JS-only
 * repo with no tsconfig has no static types to read, so this fails closed to
 * `null` with one scan-level warning rather than guessing at compiler
 * options. `rootNames` is the tsconfig's resolved `fileNames` UNIONED with
 * every route file this scan discovered (not "when available, else"): a
 * tsconfig whose `include` happens to miss a route directory would otherwise
 * leave that route's file out of the program entirely, and the union costs
 * nothing when the tsconfig already covers everything. Any failure — missing
 * compiler, missing/unparseable tsconfig, zero resolvable files, or
 * `ts.createProgram` throwing — degrades to `null` plus one warning, cached
 * so it is never retried within the scan.
 */
function checkerProgramFor(state: RouteScanState): { ts: typeof TS; program: TS.Program } | null {
  if (state.checkerProgram !== undefined) {
    return state.checkerProgram && state.checkerTs ? { ts: state.checkerTs, program: state.checkerProgram } : null;
  }
  state.checkerProgramBuilds += 1;

  const fail = (warning: string): null => {
    state.checkerProgram = null;
    state.warnings.push(warning);
    return null;
  };

  const ts = loadTypescript(state.root);
  if (!ts) return fail("route-scan checker collector skipped: the TypeScript compiler could not be resolved from the host package");
  state.checkerTs = ts;

  const configPath = ts.findConfigFile(state.root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return fail(`route-scan checker collector skipped: no tsconfig.json found under ${state.root}`);

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return fail(`route-scan checker collector skipped: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}`);
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const rootNames = [...new Set([...parsed.fileNames, ...state.routeFiles])];
  if (rootNames.length === 0) return fail("route-scan checker collector skipped: no TypeScript source files found for the checker program");

  try {
    const options: TS.CompilerOptions = { ...parsed.options, types: [] };
    const host = ts.createCompilerHost(options);
    state.checkerProgram = ts.createProgram({ rootNames, options, host });
  } catch (error) {
    return fail(`route-scan checker collector skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ts, program: state.checkerProgram };
}

/** The as-cast or annotated-declaration type node feeding from a json read —
 * the checker collector's body-expression search. Reuses `isJsonReadExpression`
 * (parens/await/.catch peeling) so the same shapes the zod collector accepts
 * as a validator argument are accepted here as a cast/annotation target: `(await
 * req.json()) as TransferBody` and `const body: TransferBody = await
 * req.json()`. First match wins in source order; no candidate (an
 * unannotated, uncast `await req.json()` with no reads — 04 §1 Task 3's
 * "voice-proxy case") means `null`, and the checker is never consulted for
 * this route+method. */
function findCheckerCandidateType(ts: typeof TS, body: TS.Node): TS.TypeNode | null {
  let found: TS.TypeNode | null = null;
  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isAsExpression(node) && isJsonReadExpression(ts, node.expression)) {
      found = node.type;
      return;
    }
    if (ts.isVariableDeclaration(node) && node.type && node.initializer && isJsonReadExpression(ts, node.initializer)) {
      found = node.type;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** One TypeScript type's conversion verdict — same shape and fail-closed
 * discipline as `static-ts.ts`'s `ZodSchemaResult`/`zodBase`'s object case:
 * `recognized: false` means the WHOLE type is outside the supported subset
 * (bubbles up to a permissive schema + note at the caller); a recognized
 * object with an unsupported property keeps the object (`{}` for that one
 * property) and carries the property's reason instead of failing the whole
 * type closed. */
interface CheckerTypeResult {
  schema: Record<string, unknown>;
  recognized: boolean;
  reason?: string;
}

function checkerUnrecognized(reason: string): CheckerTypeResult {
  return { schema: {}, recognized: false, reason };
}

function checkerLiteralValue(ts: typeof TS, type: TS.Type): string | number | boolean | undefined {
  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return (type as TS.Type & { intrinsicName?: string }).intrinsicName === "true";
  }
  return undefined;
}

/** The union's members with `undefined`/`void` stripped — how optionality
 * from a `T | undefined` union (as opposed to a `?` modifier) is detected,
 * same rule `catalog-scan.ts`'s `withoutUndefined` uses. A non-union type
 * degrades to a one-element array of itself so callers can treat both shapes
 * uniformly. */
function withoutUndefinedMembers(ts: typeof TS, type: TS.Type): TS.Type[] {
  if (!type.isUnion()) return [type];
  return type.types.filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0);
}

/** Bounded TS type → JSON Schema conversion (04 §1 Task 3's supported
 * subset): primitives, string/number literal unions → `enum`, arrays,
 * nested object literals, optionality from `?` or a `| undefined` union.
 * Depth-capped at `MAX_RESOLVE_DEPTH` (the same static-interpretation-depth
 * precedent `static-ts.ts`'s `zodFromExpression` uses). Mapped types,
 * generic type parameters, tuples, and callable types are outside the
 * supported subset and fail closed (`recognized: false`) rather than risk a
 * wrong schema. */
function schemaForCheckerType(ts: typeof TS, checker: TS.TypeChecker, type: TS.Type, depth: number): CheckerTypeResult {
  if (depth > MAX_RESOLVE_DEPTH) {
    return checkerUnrecognized(`type nesting exceeded the static interpretation depth (${checker.typeToString(type)})`);
  }

  const members = withoutUndefinedMembers(ts, type);
  if (members.length === 0) return { schema: {}, recognized: true };
  if (type.isUnion() && members.length === 1) return schemaForCheckerType(ts, checker, members[0]!, depth);

  if (type.isUnion()) {
    if (members.every((member) => (member.flags & ts.TypeFlags.BooleanLiteral) !== 0)) {
      return { schema: { type: "boolean" }, recognized: true };
    }
    const values = members.map((member) => checkerLiteralValue(ts, member));
    if (values.every((value): value is string => typeof value === "string")) {
      return { schema: { type: "string", enum: values }, recognized: true };
    }
    if (values.every((value): value is number => typeof value === "number")) {
      return { schema: { type: "number", enum: values }, recognized: true };
    }
    return checkerUnrecognized(`union type is not statically interpreted (${checker.typeToString(type)})`);
  }

  const literal = checkerLiteralValue(ts, type);
  if (literal !== undefined) return { schema: { const: literal }, recognized: true };
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { schema: { type: "string" }, recognized: true };
  if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0) return { schema: { type: "number" }, recognized: true };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { schema: { type: "boolean" }, recognized: true };
  if ((type.flags & ts.TypeFlags.Null) !== 0) return { schema: { type: "null" }, recognized: true };

  if (checker.isArrayType(type)) {
    const itemType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (!itemType) return checkerUnrecognized(`array item type could not be resolved (${checker.typeToString(type)})`);
    const item = schemaForCheckerType(ts, checker, itemType, depth + 1);
    return item.recognized
      ? { schema: { type: "array", items: item.schema }, recognized: true, ...(item.reason ? { reason: item.reason } : {}) }
      : { schema: { type: "array" }, recognized: true, reason: item.reason };
  }

  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return checkerUnrecognized(`callable type is not statically interpreted (${checker.typeToString(type)})`);
  }
  if (checker.isTupleType(type)) return checkerUnrecognized(`tuple type is not statically interpreted (${checker.typeToString(type)})`);
  if ((type.flags & ts.TypeFlags.Object) === 0) return checkerUnrecognized(`unsupported type (${checker.typeToString(type)})`);

  const objectFlags = (type as TS.Type & { objectFlags?: number }).objectFlags ?? 0;
  if ((objectFlags & ts.ObjectFlags.Mapped) !== 0) return checkerUnrecognized(`mapped type is not statically interpreted (${checker.typeToString(type)})`);
  if (type.isTypeParameter()) return checkerUnrecognized(`generic type parameter is not statically interpreted (${checker.typeToString(type)})`);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const reasons: string[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) {
      properties[property.name] = {};
      reasons.push(`${property.name}: property declaration unavailable`);
      continue;
    }
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const converted = schemaForCheckerType(ts, checker, propertyType, depth + 1);
    properties[property.name] = converted.recognized ? converted.schema : {};
    if (converted.reason) reasons.push(`${property.name}: ${converted.reason}`);
    const isOptionalFlag = (property.flags & ts.SymbolFlags.Optional) !== 0;
    const strippedLength = withoutUndefinedMembers(ts, propertyType).length;
    const fullLength = propertyType.isUnion() ? propertyType.types.length : 1;
    if (!isOptionalFlag && strippedLength === fullLength) required.push(property.name);
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
  return { schema, recognized: true, ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}) };
}

async function checkerCollector(
  route: RouteContext,
  method: HttpMethod,
  state: RouteScanState,
): Promise<RouteInputResult | null> {
  // Cheap syntactic pre-check, reusing the SAME parse the zod collector
  // already cached (zodExtractionFor/parseModule run unconditionally before
  // this collector is ever asked) — a handler with no cast/annotation
  // candidate at all (the vast majority of handlers, including every
  // existing route-scan fixture) returns null right here, without ever
  // building the `ts.Program`. This is what keeps a JS/untyped repo's fail-
  // closed output byte-identical: the "no tsconfig.json" warning below is
  // only ever reachable when a route ACTUALLY has evidence worth chasing.
  const extraction = zodExtractionFor(state);
  if (!extraction) return null;
  const syntacticModule = parseModule(extraction, route.file, route.source);
  const syntacticBody = methodHandlerBody(syntacticModule, extraction.ts, method);
  if (!syntacticBody || !findCheckerCandidateType(extraction.ts, syntacticBody)) return null;

  const resolved = checkerProgramFor(state);
  if (!resolved) return null;
  const { ts, program } = resolved;

  const sourceFile = program.getSourceFile(route.file);
  if (!sourceFile) return null;
  const body = methodHandlerBody({ file: route.file, source: route.source, sf: sourceFile }, ts, method);
  if (!body) return null;
  const typeNode = findCheckerCandidateType(ts, body);
  if (!typeNode) return null;

  const checker = program.getTypeChecker();
  const type = checker.getTypeFromTypeNode(typeNode);
  const interpreted = schemaForCheckerType(ts, checker, type, 0);
  const bodySchema = interpreted.recognized ? interpreted.schema : { ...PERMISSIVE_INPUT };
  const note = interpreted.recognized
    ? interpreted.reason
      ? `input schema partially interpreted; permissive where unknown (${interpreted.reason})`
      : undefined
    : `input schema not statically interpreted (${interpreted.reason ?? "unsupported type"}); permissive schema emitted`;

  return { bodySchema: excludePathParams(bodySchema, route.urlPath), ...(note ? { note } : {}) };
}
