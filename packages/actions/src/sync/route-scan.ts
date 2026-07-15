import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtractedTool, HttpMethod } from "../formats.js";
import {
  allocateToolName,
  extractedRisk,
  importReferenceFor,
  resolveImportSource,
  routeToolFullName,
  splitTopLevel,
  stripComments,
  topLevelObjectLiteral,
  unclassifiedToolFullName,
  walk,
} from "./common.js";

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

function addMethodsFromList(methods: Set<HttpMethod>, value: string): void {
  for (const match of value.matchAll(/["'](GET|POST|PUT|PATCH|DELETE)["']/g)) addMethod(methods, match[1]);
  for (const part of value.split(",")) addMethod(methods, part.trim());
}

function statementEnd(source: string, start: number): number {
  let depth = 0;
  let quote: "'" | "\"" | "`" | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) return index;
    else if (character === "\n" && depth === 0 && /^(?:export|import|const|let|var|function|class)\b/.test(source.slice(index + 1).trimStart())) return index;
  }
  return source.length;
}

function exportedVerbs(source: string, kind: RouteSource["kind"]): Set<HttpMethod> {
  const methods = new Set<HttpMethod>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) {
    addMethod(methods, match[1]);
  }
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+/g)) {
    const start = (match.index ?? 0) + match[0].length;
    for (const declaration of splitTopLevel(source.slice(start, statementEnd(source, start)))) {
      addMethod(methods, declaration.trim().match(/^([A-Za-z_$][\w$]*)\b/)?.[1]);
    }
  }
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    addMethodsFromList(methods, match[1] ?? "");
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}(?!\s*from\b)/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const trimmed = part.trim();
      addMethod(methods, trimmed.match(/\bas\s+(GET|POST|PUT|PATCH|DELETE)\b/)?.[1] ?? trimmed);
    }
  }
  if (kind === "pages") {
    for (const match of source.matchAll(/\breq\.method\s*(?:={2,3}|!={1,2})\s*["'](GET|POST|PUT|PATCH|DELETE)["']/g)) {
      addMethod(methods, match[1]);
    }
    for (const match of source.matchAll(/\bcase\s+["'](GET|POST|PUT|PATCH|DELETE)["']/g)) addMethod(methods, match[1]);
    for (const match of source.matchAll(/setHeader\(\s*["']Allow["']\s*,\s*\[([^\]]+)\]/g)) addMethodsFromList(methods, match[1] ?? "");
    for (const match of source.matchAll(/setHeader\(\s*["']Allow["']\s*,\s*["']([^"']+)["']/g)) addMethodsFromList(methods, match[1] ?? "");
    if (/\bNextAuth\s*\(/.test(source)) {
      methods.add("GET");
      methods.add("POST");
    }
  }
  return methods;
}

function firstObjectArgument(source: string, callee: RegExp): string | null {
  for (const match of source.matchAll(callee)) {
    let index = (match.index ?? 0) + match[0].length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "(") continue;
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] === "{") return topLevelObjectLiteral(source, index);
  }
  return null;
}

function methodKeyObjectVerbs(source: string): Set<HttpMethod> | null {
  const body = firstObjectArgument(source, /\bdefaultHandler\s*/g);
  if (!body) return null;
  const methods = new Set<HttpMethod>();
  for (const entry of splitTopLevel(body)) {
    const key = entry.trim().match(/^(?:(["'])(GET|POST|PUT|PATCH|DELETE)\1|(GET|POST|PUT|PATCH|DELETE))\s*:/);
    addMethod(methods, key?.[2] ?? key?.[3]);
  }
  return methods.size > 0 ? methods : null;
}

function routeMapVerbs(source: string, route: RouteSource): Set<HttpMethod> | null {
  const entries = [...source.matchAll(/["'](GET|POST|PUT|PATCH|DELETE)\s+([^"']+)["']\s*:/g)];
  if (entries.length === 0) return null;
  const methods = new Set<HttpMethod>();
  const itemRoute = /\/\{[^}]+\}$/.test(route.urlPath);
  for (const entry of entries) {
    const rootEntry = (entry[2] ?? "/") === "/";
    if (route.catchAll || (itemRoute ? !rootEntry : rootEntry)) addMethod(methods, entry[1]);
  }
  return methods;
}

async function reExportTargets(source: string): Promise<ReExportTarget[]> {
  const targets: ReExportTarget[] = [];
  for (const match of source.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) targets.push({ specifier: match[1], assumeDefaultExport: false });
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*from\s+["']([^"']+)["']/g)) {
    const specifier = match[2];
    if (!specifier) continue;
    for (const part of (match[1] ?? "").split(",")) {
      const names = part.trim().split(/\s+as\s+/).map((name) => name.trim());
      if ((names[1] ?? names[0]) === "default") targets.push({ specifier, assumeDefaultExport: true });
      else if (HTTP_METHOD_SET.has(names[1] ?? names[0] ?? "")) {
        targets.push({ specifier, assumeDefaultExport: false });
      }
    }
  }
  const importedDefault = source.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'][\s\S]*?export\s+default\s+\1\b/);
  if (importedDefault?.[2]) targets.push({ specifier: importedDefault[2], assumeDefaultExport: true });
  const delegate = source.match(/return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\s*,\s*res\b/);
  const delegateReference = delegate?.[1] ? await importReferenceFor(source, delegate[1]) : undefined;
  if (delegateReference) targets.push({ specifier: delegateReference.specifier, assumeDefaultExport: true });
  return targets;
}

function hasDefaultHandler(source: string, assumed: boolean): boolean {
  return assumed || /\bexport\s+default\b/.test(source) || /export\s*\{[^}]+(?:\bas\s+default\b|\bdefault\b)[^}]*\}\s*from\b/.test(source);
}

function inferredPageVerbs(source: string, route: RouteSource, assumed = false): Set<HttpMethod> {
  const methods = new Set<HttpMethod>();
  if (route.kind !== "pages" || !hasDefaultHandler(source, assumed) || /\breq\.method\b/.test(source)) return methods;
  if (/\bcreateNextApiHandler\s*\(/.test(source)) {
    methods.add("GET");
    methods.add("POST");
  } else if (/\bhandlerMap\b/.test(source) && /\bapiHandlers\b/.test(source) && route.catchAll) {
    methods.add("POST");
  } else if (/\bhandleUpload\s*\(/.test(source) || /\breq\.body\b/.test(source)) {
    methods.add("POST");
  } else if (/\bbodyParser\s*:\s*false\b/.test(source) || route.urlPath.endsWith("/webhook")) {
    methods.add("POST");
  }
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
  const evidenceSource = stripComments(source);
  const direct = exportedVerbs(evidenceSource, route.kind);
  if (direct.size > 0) return direct;
  const mapped = routeMapVerbs(evidenceSource, route);
  if (mapped) return mapped;
  const objectMethods = methodKeyObjectVerbs(evidenceSource);
  if (objectMethods) return objectMethods;
  if (depth < MAX_REEXPORT_DEPTH) {
    const resolvedMethods = new Set<HttpMethod>();
    for (const target of await reExportTargets(evidenceSource)) {
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
      for (const method of nested) resolvedMethods.add(method);
    }
    if (resolvedMethods.size > 0) return resolvedMethods;
  }
  return inferredPageVerbs(evidenceSource, route, assumeDefaultExport);
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
      tools.push({
        name,
        description: `${method} ${route.urlPath}`,
        inputSchema: routeInputSchema(route.urlPath),
        risk: extractedRisk(method, name, "route"),
        binding: {
          kind: "route",
          method,
          path: route.urlPath,
          argsIn: method === "GET" || method === "DELETE" ? "query" : "body",
        },
      });
    }
  }
  return { tools, warnings };
}
