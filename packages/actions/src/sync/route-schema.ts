import type TS from "typescript";
import type { HttpMethod } from "../formats.js";
import {
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
 * emits today (path params only, blank body/query). Task 2 (this module) fills
 * in the zod collector; Tasks 3-4 (checker, query) still return nothing.
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
 * Task 3 grows this further with a lazily built `ts.Program` for the checker
 * collector. Growing this interface in place is how later collectors avoid
 * re-parsing modules, or re-touching route-scan.ts's call site, ever again.
 */
export interface RouteScanState {
  root: string;
  zodExtraction?: StaticExtraction | null;
}

export function createRouteScanState(root: string): RouteScanState {
  return { root };
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
 * Task 2 (zod-in-handler) is wired below; Tasks 3 (TypeScript checker) and 4
 * (query) still return nothing and land in later commits.
 */
export async function inferRouteInput(
  route: RouteContext,
  method: HttpMethod,
  state: RouteScanState,
): Promise<RouteInputResult | null> {
  return zodCollector(route, method, state);
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
